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
            // Fallback to got-scraping with enhanced anti-detection
            log.info('Using got-scraping with enhanced headers...');
            
            try {
                const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
                log.info(`Using proxy: ${proxyUrl ? 'YES' : 'NO'}`);
                
                // Add random delay to seem more human-like
                await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
                
                const response = await gotScraping({
                    url: startUrl,
                    proxyUrl,
                    timeout: { request: 60000 },
                    retry: { limit: 3 },
                    http2: true,
                    headerGeneratorOptions: {
                        browsers: [
                            { name: 'chrome', minVersion: 120, maxVersion: 130 },
                            { name: 'edge', minVersion: 120, maxVersion: 130 }
                        ],
                        devices: ['desktop'],
                        operatingSystems: ['windows', 'macos'],
                        locales: ['en-US'],
                    },
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache',
                        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                        'Sec-Ch-Ua-Mobile': '?0',
                        'Sec-Ch-Ua-Platform': '"Windows"',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none',
                        'Sec-Fetch-User': '?1',
                        'Upgrade-Insecure-Requests': '1',
                        'Referer': 'https://www.google.com/',
                    },
                });
                
                log.info(`Response status: ${response.statusCode}`);
                
                if (response.statusCode !== 200) {
                    if (response.statusCode === 403) {
                        log.warning('Got 403 - G2.com is blocking the request. Try using Playwright instead.');
                        // Save the response for debugging
                        await Actor.setValue('BLOCKED_RESPONSE', {
                            status: response.statusCode,
                            headers: response.headers,
                            body: response.body.substring(0, 1000),
                            url: startUrl
                        });
                    }
                    throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
                }
                
                const $ = cheerio.load(response.body);
                
                // Save a sample of the page for debugging
                await Actor.setValue('PAGE_SAMPLE', response.body.substring(0, 2000));
                
                const reviewCards = $('[data-test="review-card"], .paper--white, .review-card');
                log.info(`Found ${reviewCards.length} review cards with got-scraping`);
                
                if (reviewCards.length === 0) {
                    log.warning('No review cards found. Page might require JavaScript or have different selectors.');
                    // Try alternative selectors
                    const alternativeCards = $('.review, [class*="review"], [data-testid*="review"]');
                    log.info(`Found ${alternativeCards.length} alternative review elements`);
                }
                
                reviewCards.each((index, element) => {
                    if (totalCollected >= maxReviews) return false;
                    
                    const $card = $(element);
                    const title = $card.find('h3, h4, .h4, [data-test*="title"]').first().text().trim() || `Review ${index + 1}`;
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
                
                // If got-scraping fails, automatically fall back to Playwright
                if (error.message.includes('403') || error.message.includes('blocked')) {
                    log.info('Automatically switching to Playwright due to blocking...');
                    
                    const PlaywrightCrawler = (await import('crawlee')).PlaywrightCrawler;
                    
                    const crawler = new PlaywrightCrawler({
                        proxyConfiguration,
                        maxRequestsPerCrawl: 1,
                        navigationTimeoutSecs: 60,
                        requestHandlerTimeoutSecs: 120,
                        maxConcurrency: 1,
                        launchContext: {
                            launchOptions: {
                                headless: true,
                                args: [
                                    '--disable-blink-features=AutomationControlled',
                                    '--disable-dev-shm-usage',
                                    '--disable-setuid-sandbox',
                                    '--no-sandbox',
                                ],
                            },
                        },
                        requestHandler: async ({ page, log: crawlerLog }) => {
                            crawlerLog.info('Fallback Playwright processing...');
                            
                            try {
                                await page.waitForSelector('body', { timeout: 30000 });
                                await page.waitForTimeout(3000); // Wait for dynamic content
                                
                                const pageReviews = await page.evaluate(() => {
                                    const reviewsData = [];
                                    const cards = document.querySelectorAll('[data-test="review-card"], .paper--white, .review-card, .review, [class*="review"]');
                                    
                                    cards.forEach((card, index) => {
                                        const titleEl = card.querySelector('h3, h4, .h4, [data-test*="title"], [class*="title"]');
                                        const contentEl = card.querySelector('.formatted-text, .review-content, p, [class*="content"]');
                                        
                                        const title = titleEl ? titleEl.textContent.trim() : `Review ${index + 1}`;
                                        const content = contentEl ? contentEl.textContent.trim() : '';
                                        
                                        if (title || content) {
                                            reviewsData.push({
                                                review_id: index + 1,
                                                review_title: title,
                                                review_content: content,
                                                scraped_from: 'playwright_fallback'
                                            });
                                        }
                                    });
                                    
                                    return reviewsData;
                                });
                                
                                const validReviews = pageReviews.slice(0, maxReviews);
                                reviews.push(...validReviews);
                                totalCollected = reviews.length;
                                
                                crawlerLog.info(`Playwright fallback found ${validReviews.length} reviews`);
                                
                            } catch (fallbackError) {
                                crawlerLog.error(`Playwright fallback also failed: ${fallbackError.message}`);
                                throw fallbackError;
                            }
                        },
                    });
                    
                    await crawler.run([{ url: startUrl }]);
                    
                } else {
                    throw error;
                }
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