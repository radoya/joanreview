import { Actor, log } from 'apify';

// Add error handling for the entire actor
Actor.main(async () => {
    try {
        log.info('Actor starting...');
        
        // Test basic functionality first
        const input = await Actor.getInput();
        log.info('Input received:', input);
        
        if (!input) {
            throw new Error('No input provided to the actor');
        }
        
        const { company_name, maxReviews = 20, usePlaywright = true } = input;
        
        if (!company_name) {
            throw new Error('You must provide "company_name" input!');
        }
        
        log.info(`Starting scrape for company: ${company_name}, max reviews: ${maxReviews}, use Playwright: ${usePlaywright}`);
        
        // Import dependencies after basic checks
        log.info('Loading dependencies...');
        
        let PlaywrightCrawler, Configuration, gotScraping, cheerio;
        
        try {
            const crawlee = await import('crawlee');
            PlaywrightCrawler = crawlee.PlaywrightCrawler;
            Configuration = crawlee.Configuration;
            log.info('Crawlee loaded successfully');
        } catch (err) {
            log.error('Failed to load crawlee:', err.message);
            throw err;
        }
        
        try {
            const gotScrapingModule = await import('got-scraping');
            gotScraping = gotScrapingModule.gotScraping;
            log.info('got-scraping loaded successfully');
        } catch (err) {
            log.error('Failed to load got-scraping:', err.message);
            throw err;
        }
        
        try {
            cheerio = await import('cheerio');
            log.info('cheerio loaded successfully');
        } catch (err) {
            log.error('Failed to load cheerio:', err.message);
            throw err;
        }
        
        // Configure crawlee
        Configuration.set('memoryMbytes', 4096);
        Configuration.set('systemInfoIntervalMillis', 60000);
        
        const startUrl = `https://www.g2.com/products/${company_name}/reviews`;
        log.info(`Start URL: ${startUrl}`);
        
        let proxyConfiguration;
        try {
            proxyConfiguration = await Actor.createProxyConfiguration({
                groups: ['RESIDENTIAL'],
                countryCode: 'US',
            });
            log.info('Proxy configuration created');
        } catch (err) {
            log.warning('Failed to create proxy configuration, continuing without proxy:', err.message);
            proxyConfiguration = null;
        }
        
        const reviews = [];
        let totalCollected = 0;
        
        if (usePlaywright) {
            log.info('Using Playwright crawler...');
            
            const crawler = new PlaywrightCrawler({
                proxyConfiguration,
                maxRequestsPerCrawl: Math.ceil(maxReviews / 10) + 1,
                navigationTimeoutSecs: 60,
                requestHandlerTimeoutSecs: 120,
                maxConcurrency: 1,
                sessionPoolOptions: {
                    maxPoolSize: 1,
                    sessionRotationCount: 5,
                },
                launchContext: {
                    launchOptions: {
                        headless: true,
                        args: [
                            '--disable-blink-features=AutomationControlled',
                            '--disable-features=site-per-process',
                            '--disable-dev-shm-usage',
                            '--disable-setuid-sandbox',
                            '--no-sandbox',
                        ],
                    },
                },
                preNavigationHooks: [
                    async ({ page }) => {
                        await page.evaluateOnNewDocument(() => {
                            Object.defineProperty(navigator, 'webdriver', {
                                get: () => undefined,
                            });
                            window.chrome = { runtime: {} };
                        });
                        
                        await page.setViewportSize({ width: 1920, height: 1080 });
                        await page.setExtraHTTPHeaders({
                            'Accept-Language': 'en-US,en;q=0.9',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        });
                    },
                ],
                requestHandler: async ({ request, page, log: crawlerLog }) => {
                    const currentPage = request.userData.page || 1;
                    crawlerLog.info(`Processing page ${currentPage}`);
                    
                    try {
                        // Wait for page to load
                        await page.waitForSelector('body', { timeout: 30000 });
                        
                        // Check if we can find any review elements
                        const reviewSelectors = [
                            '[data-test="review-card"]',
                            '.paper--white',
                            '.review-card',
                            '.review',
                            '[data-testid*="review"]'
                        ];
                        
                        let reviewCards = [];
                        for (const selector of reviewSelectors) {
                            try {
                                await page.waitForSelector(selector, { timeout: 5000 });
                                reviewCards = await page.$$(selector);
                                if (reviewCards.length > 0) {
                                    crawlerLog.info(`Found ${reviewCards.length} elements with selector: ${selector}`);
                                    break;
                                }
                            } catch (err) {
                                // Try next selector
                            }
                        }
                        
                        if (reviewCards.length === 0) {
                            crawlerLog.warning('No review cards found on page');
                            const pageContent = await page.content();
                            await Actor.setValue(`DEBUG_PAGE_${currentPage}`, pageContent, { 
                                contentType: 'text/html' 
                            });
                            return;
                        }
                        
                        // Extract basic review data
                        const pageReviews = await page.evaluate(() => {
                            const reviewsData = [];
                            const cards = document.querySelectorAll('[data-test="review-card"], .paper--white, .review-card, .review, [data-testid*="review"]');
                            
                            cards.forEach((card, index) => {
                                const titleEl = card.querySelector('h3, h4, .h4, [data-test*="title"]');
                                const contentEl = card.querySelector('.formatted-text, .review-content, p');
                                
                                const title = titleEl ? titleEl.textContent.trim() : `Review ${index + 1}`;
                                const content = contentEl ? contentEl.textContent.trim() : '';
                                
                                if (title || content) {
                                    reviewsData.push({
                                        review_id: index + 1,
                                        review_title: title,
                                        review_content: content,
                                        scraped_from: 'playwright'
                                    });
                                }
                            });
                            
                            return reviewsData;
                        });
                        
                        const validReviews = pageReviews.slice(0, maxReviews - totalCollected);
                        reviews.push(...validReviews);
                        totalCollected = reviews.length;
                        
                        crawlerLog.info(`Found ${validReviews.length} reviews, total: ${totalCollected}`);
                        
                    } catch (error) {
                        crawlerLog.error(`Error processing page: ${error.message}`);
                        throw error;
                    }
                },
            });
            
            await crawler.run([{
                url: startUrl,
                userData: { page: 1 }
            }]);
            
        } else {
            // Fallback to got-scraping
            log.info('Using got-scraping...');
            
            try {
                const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
                
                const response = await gotScraping({
                    url: startUrl,
                    proxyUrl,
                    timeout: { request: 30000 },
                    retry: { limit: 2 },
                });
                
                if (response.statusCode !== 200) {
                    throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
                }
                
                const $ = cheerio.load(response.body);
                const reviewCards = $('[data-test="review-card"], .paper--white, .review-card');
                
                log.info(`Found ${reviewCards.length} review cards with got-scraping`);
                
                reviewCards.each((index, element) => {
                    if (totalCollected >= maxReviews) return false;
                    
                    const $card = $(element);
                    const title = $card.find('h3, h4, .h4').first().text().trim() || `Review ${index + 1}`;
                    const content = $card.find('.formatted-text, .review-content, p').first().text().trim();
                    
                    if (title || content) {
                        reviews.push({
                            review_id: index + 1,
                            review_title: title,
                            review_content: content,
                            scraped_from: 'got-scraping'
                        });
                        totalCollected++;
                    }
                });
                
            } catch (error) {
                log.error(`got-scraping failed: ${error.message}`);
                throw error;
            }
        }
        
        // Save results
        log.info(`Scraped ${reviews.length} reviews total`);
        
        if (reviews.length > 0) {
            await Actor.pushData(reviews);
        }
        
        await Actor.setValue('OUTPUT', {
            company: company_name,
            total_reviews: reviews.length,
            reviews: reviews,
            scraped_at: new Date().toISOString(),
            success: true
        });
        
        log.info('Actor completed successfully');
        
    } catch (error) {
        log.error('Actor failed with error:', error);
        
        // Save error details
        await Actor.setValue('ERROR_DETAILS', {
            error_message: error.message,
            error_stack: error.stack,
            timestamp: new Date().toISOString()
        });
        
        // Still try to save some output
        await Actor.setValue('OUTPUT', {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
        
        throw error; // Re-throw to mark actor as failed
    }
});