/**
 * Cloudflare Worker Scheduled Event Handler
 * This function is triggered by the cron jobs defined in wrangler.toml
 */

import { createClient } from '@supabase/supabase-js';
import productsData from '../products.txt';

export default {
	/**
	 * @param {import("@cloudflare/workers-types").ScheduledEvent} event
	 * @param {import("@cloudflare/workers-types").Env} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 */
	/**
	 * @param {import("@cloudflare/workers-types").ScheduledEvent} event
	 * @param {import("@cloudflare/workers-types").Env} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 */
	async scheduled(event, env, ctx) {
		console.log(`Cron triggered at: ${new Date().toISOString()}`);

		// 1. Get products from imported text and shuffle them
		const productList = productsData.split('\n')
			.map(s => s.trim())
			.filter(s => s.length > 0 && s.toLowerCase() !== 'products');
		
		// Shuffle array to pick different candidates each run
		const shuffledProducts = productList.sort(() => Math.random() - 0.5);

		const rssFeeds = [
			"https://www.nature.com/nm/current_issue/rss/index.html",
			"https://www.sciencedaily.com/rss/health_medicine.xml",
			"https://www.thelancet.com/rssfeed/lancet_current.xml",
			"https://www.nejm.org/rss/recent_articles.xml",
			"https://jamanetwork.com/rss/site_3/most_recent.xml",
			"https://www.bmj.com/rss/recent.xml",
			"https://www.cell.com/cell-metabolism/rss",
		];

		const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
		let articleProcessed = false;
		
		// 2. Try products one by one until we successfully process ONE article
		// Limit to 5 products per run to avoid Cloudflare CPU timeouts
		const maxTryProducts = 5; 
		const productsToTry = shuffledProducts.slice(0, maxTryProducts);

		for (const currentProduct of productsToTry) {
			console.log(`Attempting to find articles for: ${currentProduct}`);
			
			try {
				// 3. Fetch from RSS and PubMed for this product
				let candidateArticles = [];
				
				// Search RSS
				for (const url of rssFeeds) {
					try {
						const items = await this.fetchAndParseRSS(url);
						candidateArticles = candidateArticles.concat(items.filter(article => {
							const content = (article.title + article.snippet).toLowerCase();
							return content.includes(currentProduct.toLowerCase());
						}));
					} catch (rssErr) {
						console.error(`RSS Error (${url}):`, rssErr.message);
					}
				}

				// Search PubMed
				try {
					const pubMedArticles = await this.searchAndFetchPubMed(currentProduct);
					candidateArticles = candidateArticles.concat(pubMedArticles);
				} catch (pmErr) {
					console.error(`PubMed Error:`, pmErr.message);
				}

				if (candidateArticles.length === 0) {
					console.log(`No articles found for "${currentProduct}". Trying next product...`);
					continue;
				}

				console.log(`Found ${candidateArticles.length} candidates for "${currentProduct}". Checking for new content...`);

				// 4. Process the first non-duplicate article
				for (const article of candidateArticles) {
					const isDuplicate = await this.isArticleDuplicate(article.link, supabase);
					if (isDuplicate) {
						continue;
					}

					console.log(`Processing new article: ${article.title}`);
					const summary = await this.summarizeWithDeepSeek(currentProduct, article.title, article.snippet, env);

					const { error } = await supabase
						.from('blog')
						.insert([{
							content: summary,
							tag: currentProduct,
							url: article.link
						}]);

					if (!error) {
						console.log(`Successfully stored article for ${currentProduct}!`);
						articleProcessed = true;
						break; // Found and processed one, we are done
					} else {
						console.error(`Insert failed:`, error.message);
					}
				}

				if (articleProcessed) break; // Exit the product loop

			} catch (error) {
				console.error(`Error processing product "${currentProduct}":`, error.message);
			}
		}

		if (!articleProcessed) {
			console.log(`Tried ${productsToTry.length} products but found no new relevant articles.`);
		}
		
		console.log('Cron process completed.');
	},

	/**
	 * Fetch RSS feed and parse into basic structure using Regex (lightweight for Workers)
	 */
	async fetchAndParseRSS(url) {
		try {
			const response = await fetch(url, {
				headers: { 'User-Agent': 'Mozilla/5.0 Cloudflare Worker' },
				signal: AbortSignal.timeout(5000) // 5s timeout
			});
			const text = await response.text();

			const items = [];
			// Regex to extract <item> or <entry> blocks
			const itemRegex = /<(item|entry)>([\s\S]*?)<\/\1>/g;
			let match;

			while ((match = itemRegex.exec(text)) !== null) {
				const content = match[2];
				const title = this.extractTagContent(content, 'title');
				const link = this.extractTagContent(content, 'link') || this.extractHref(content);
				const description = this.extractTagContent(content, 'description') || this.extractTagContent(content, 'summary') || "";

				if (title && link) {
					items.push({
						title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
						link: link.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
						snippet: description.replace(/<!\[CDATA\[|\]\]>|<[^>]*>/g, '').trim().substring(0, 500)
					});
				}
			}
			return items;
		} catch (err) {
			console.error(`RSS fetch error for ${url}:`, err.message);
			return [];
		}
	},

	extractTagContent(xml, tag) {
		const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i');
		const match = xml.match(regex);
		return match ? match[1] : null;
	},

	extractHref(xml) {
		const match = xml.match(/<link[^>]+href=["']([^"']+)["']/i);
		return match ? match[1] : null;
	},

	/**
	 * Search and fetch details from PubMed
	 */
	async searchAndFetchPubMed(query) {
		try {
			// Step 1: Search for IDs
			const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=5`;
			const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(5000) });
			const searchData = await searchRes.json();
			const ids = searchData?.esearchresult?.idlist || [];

			if (ids.length === 0) return [];

			// Step 2: Fetch Summaries
			const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
			const summaryRes = await fetch(summaryUrl, { signal: AbortSignal.timeout(5000) });
			const summaryData = await summaryRes.json();
			const results = summaryData?.result || {};

			return ids.map(id => {
				const item = results[id];
				return {
					title: item?.title || "No Title",
					link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
					snippet: item?.source + ". " + (item?.pubdate || "") + ". " + (item?.fulljournalname || "")
				};
			});
		} catch (err) {
			console.error('PubMed API error:', err.message);
			return [];
		}
	},

	/**
	 * Check if an article URL already exists in Supabase
	 */
	async isArticleDuplicate(url, supabase) {
		const { data, error } = await supabase
			.from('blog')
			.select('url')
			.eq('url', url)
			.limit(1);

		if (error) {
			console.error('Deduplication check error:', error.message);
			return false;
		}

		return data.length > 0;
	},

	/**
	 * Summarize article using DeepSeek API
	 */
	async summarizeWithDeepSeek(product, title, snippet, env) {
		if (!env.DEEPSEEK_API_KEY) {
			console.warn('DEEPSEEK_API_KEY is missing. Using fallback summary.');
			return `# ${title}\n\n[AI Summary Placeholder] ${snippet.substring(0, 200)}...`;
		}

		const prompt = `You are a professional medical science writer. Based on the following article title and snippet, write a high-quality science popularization summary about the product: 【${product}】.

Requirements:
1. Language: Use professional yet accessible **ENGLISH**.
2. Format: The first line must be the article's full title in Markdown H1 format (e.g., # Article Title).
3. Structure: You MUST use the following Markdown structure:
   # [Original Title]
   ### 1. Summary of Core Content
   Briefly summarize the main research findings or core news points of the article.
   ### 2. Advantages and Benefits
   List the main strengths or positive impacts on health based on the article.
   ### 3. Potential Risks and Shortcomings
   List possible side effects, limitations, or risks based on the article.
   ### 4. Precautions for Use
   Provide professional health advice, contraindications, or details patients should note.
4. Style: Ensure the content is accurate yet understandable for the general public.
5. Length: Approximately 400-500 words.

---
**Article Title**: ${title}
**Snippet**: ${snippet}`;

		try {
			const response = await fetch('https://api.deepseek.com/chat/completions', {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: "deepseek-chat",
					messages: [
						{ role: "system", content: "You are a professional medical assistant providing high-quality summaries." },
						{ role: "user", content: prompt }
					],
					stream: false
				})
			});

			const data = await response.json();
			return data.choices?.[0]?.message?.content || `${title}: Summary generation failed.`;
		} catch (err) {
			console.error('DeepSeek prompt error:', err.message);
			return `${title}: Error during AI summarization.`;
		}
	},

	// Optional: Handle HTTP requests for manual testing or Sitemap
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// 1. Manual Sync Trigger (?test)
		if (url.searchParams.has('test')) {
			console.log('Manual test trigger via HTTP');
			await this.scheduled({ cron: "manual" }, env, ctx);
			return new Response('Manual test triggered. Check Cloudflare Logs for detailed progress.');
		}

		// 2. Dynamic Sitemap (/sitemap.xml)
		if (url.pathname === '/sitemap.xml') {
			const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
			
			// Fetch all article URLs from Supabase
			const { data, error } = await supabase
				.from('blog')
				.select('url, created_at')
				.order('created_at', { ascending: false });

			if (error) {
				return new Response('Error generating sitemap', { status: 500 });
			}

			// Generate XML
			const baseUrl = url.origin;
			const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${data.map(item => `  <url>
    <loc>${item.url}</loc>
    <lastmod>${new Date(item.created_at || Date.now()).toISOString().split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>`).join('\n')}
</urlset>`;

			return new Response(xml, {
				headers: {
					'Content-Type': 'application/xml; charset=utf-8',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		}

		return new Response('Worker is running. Visit /sitemap.xml to see indexed articles or ?test to trigger a manual sync.');
	},
};
