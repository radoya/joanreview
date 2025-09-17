import { Actor, log } from 'apify';
import { PlaywrightCrawler, Configuration } from 'crawlee';

// Configure Crawlee
Configuration.set('memoryMbytes', 4096);
Configuration.set('systemInfoIntervalMillis', 60000);

Actor.main(async () => {
    try {
        log.info('Actor starting...');
        
        const input = await Actor.getInput();
        if (!input) {
            throw new Error('No input provided to the actor');
        }
        
        const { company_name, maxReviews = 20 } = input;
        if (!company_name) {
            throw new Error('You must provide "company_name" input!');
        }
        
        log.info(`Starting scrape for company: ${company_name}, max reviews: ${maxReviews}`);
        
        const startUrl = `https://www.g2.com/products/${company_name}/reviews`;
        log.info(`Start URL: ${startUrl}`);
        
        // Create proxy configuration
        let proxyConfiguration;
        try {
            proxyConfiguration = await Actor.createProxyConfiguration({
                groups: ['RESIDENTIAL'],
                countryCode: 'US',
            });
            log.info('Proxy configuration created');
        } catch (err) {
            log.warning('Failed to create proxy configuration, continuing without proxy');
            proxyConfiguration = null;
        }
        
        const reviews = [];
        let totalCollected = 0;
        
        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestsPerCrawl: Math.ceil(maxReviews / 10) + 2,
            navigationTimeoutSecs: 90,
            requestHandlerTimeoutSecs: 180,
            maxConcurrency: 1,
            maxRequestRetries: 5,
            sessionPoolOptions: {
                maxPoolSize: 1,
                sessionOptions: {
                    maxUsageCount: 3,
                },
            },
            launchContext: {
                launchOptions: {
                    headless: true,
                    channel: 'chrome',
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-features=site-per-process',
                        '--disable-dev-shm-usage',
                        '--disable-setuid-sandbox',
                        '--no-sandbox',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor',
                    ],
                },
            },
            preNavigationHooks: [
                async ({ page }) => {
                    // Remove automation indicators
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', {
                            get: () => undefined,
                        });
                        window.chrome = { runtime: {}, loadTimes() {}, csi() {} };
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications' ?
                                Promise.resolve({ state: Notification.permission }) :
                                originalQuery(parameters)
                        );
                        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                    });

                    // Realistic UA and viewport
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
                    await page.setViewportSize({ 
                        width: 1366 + Math.floor(Math.random() * 200), 
                        height: 768 + Math.floor(Math.random() * 200) 
                    });

                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                        'Referer': 'https://www.google.com/',
                    });
                },
            ],
            requestHandler: async ({ request, page, log: crawlerLog }) => {
                const currentPage = request.userData.page || 1;
                crawlerLog.info(`Processing page ${currentPage} of ${company_name} reviews`);
                
                try {
                    // Wait for page to load
                    await page.waitForLoadState('networkidle', { timeout: 30000 });
                    
                    // Add human-like delay
                    await page.waitForTimeout(2000 + Math.random() * 3000);
                    
                    // Scroll slowly to mimic human behavior
                    await page.evaluate(async () => {
                        await new Promise(resolve => {
                            let totalHeight = 0;
                            const distance = 100;
                            const timer = setInterval(() => {
                                window.scrollBy(0, distance);
                                totalHeight += distance;
                                
                                if (totalHeight >= document.body.scrollHeight / 2) {
                                    clearInterval(timer);
                                    resolve();
                                }
                            }, 100);
                        });
                    });
                    
                    await page.waitForTimeout(1000);
                    
                    // Try to find review cards with multiple selectors
                    let reviewCardsFound = false;
                    const selectors = [
                        '[data-test="review-card"]',
                        '.paper--white',
                        '.review-card',
                        '[class*="review"][class*="card"]',
                        '.review',
                        '[data-testid*="review"]'
                    ];
                    
                    for (const selector of selectors) {
                        try {
                            await page.waitForSelector(selector, { timeout: 5000 });
                            const count = await page.locator(selector).count();
                            if (count > 0) {
                                crawlerLog.info(`Found ${count} elements with selector: ${selector}`);
                                reviewCardsFound = true;
                                break;
                            }
                        } catch (err) {
                            // Try next selector
                        }
                    }
                    
                    if (!reviewCardsFound) {
                        crawlerLog.warning('No review cards found with any selector');
                        
                        // Debug: Check page content
                        const pageTitle = await page.title();
                        const url = page.url();
                        crawlerLog.info(`Page title: "${pageTitle}", URL: ${url}`);
                        
                        // Save page content for debugging
                        const htmlContent = await page.content();
                        await Actor.setValue(`DEBUG_PAGE_${currentPage}`, htmlContent, { 
                            contentType: 'text/html' 
                        });
                        
                        // Check for common blocking indicators
                        const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
                        if (pageText.includes('captcha') || pageText.includes('blocked') || pageText.includes('bot')) {
                            crawlerLog.error('Detected blocking page');
                        }
                        
                        return;
                    }
                    
                    // Extract reviews
                    const pageReviews = await page.evaluate(() => {
                        const reviewsData = [];
                        
                        // Try multiple selectors for review cards
                        let reviewCards = document.querySelectorAll('[data-test="review-card"]');
                        if (reviewCards.length === 0) {
                            reviewCards = document.querySelectorAll('.paper--white');
                        }
                        if (reviewCards.length === 0) {
                            reviewCards = document.querySelectorAll('.review-card, [class*="review"][class*="card"]');
                        }
                        
                        reviewCards.forEach((card, index) => {
                            try {
                                // Extract review link and ID
                                const reviewLinkEl = card.querySelector('a[data-test="review-card-link"], a[href*="/reviews/"]');
                                const reviewLink = reviewLinkEl ? reviewLinkEl.getAttribute('href') : '';
                                const reviewIdMatch = reviewLink.match(/-(\d+)$/);
                                
                                // Extract title with multiple fallback selectors
                                let title = null;
                                const titleSelectors = [
                                    '[data-test="review-card-title"]',
                                    'h3', 'h4', '.h4',
                                    '[class*="title"]',
                                    'a[href*="/reviews/"]'
                                ];
                                for (const sel of titleSelectors) {
                                    const el = card.querySelector(sel);
                                    if (el && el.textContent.trim()) {
                                        title = el.textContent.trim();
                                        break;
                                    }
                                }
                                
                                // Extract content with multiple fallback selectors  
                                let content = null;
                                const contentSelectors = [
                                    '[data-test="review-card-content"]',
                                    '.formatted-text',
                                    '.review-content',
                                    'p',
                                    '[class*="content"]'
                                ];
                                for (const sel of contentSelectors) {
                                    const el = card.querySelector(sel);
                                    if (el && el.textContent.trim()) {
                                        content = el.textContent.trim();
                                        break;
                                    }
                                }
                                
                                // Extract rating
                                const ratingEl = card.querySelector('[data-test="star-rating"], .stars, [data-rating]');
                                let rating = null;
                                if (ratingEl) {
                                    rating = ratingEl.getAttribute('data-rating') || 
                                            ratingEl.textContent.match(/\d+/)?.[0];
                                    if (rating) rating = Number(rating);
                                }
                                
                                // Extract reviewer info
                                const nameEl = card.querySelector('[data-test="reviewer-display-name"], .link--header, a[href*="/users/"]');
                                const jobEl = card.querySelector('[data-test="reviewer-job-title"], .mt-4th');
                                const sizeEl = card.querySelector('[data-test="reviewer-company-size"], .company-size');
                                const dateEl = card.querySelector('time, [datetime]');
                                
                                // Only add if we have meaningful content
                                if (title || content) {
                                    reviewsData.push({
                                        review_id: reviewIdMatch ? Number(reviewIdMatch[1]) : (index + 1),
                                        review_title: title,
                                        review_content: content,
                                        review_rating: rating,
                                        reviewer: {
                                            reviewer_name: nameEl ? nameEl.textContent.trim() : null,
                                            reviewer_job_title: jobEl ? jobEl.textContent.trim() : null,
                                            reviewer_link: nameEl && nameEl.getAttribute('href') ? 
                                                `https://www.g2.com${nameEl.getAttribute('href')}` : null,
                                        },
                                        publish_date: dateEl ? dateEl.getAttribute('datetime') : null,
                                        reviewer_company_size: sizeEl ? sizeEl.textContent.trim() : null,
                                        review_link: reviewLink ? `https://www.g2.com${reviewLink}` : null,
                                        scraped_from: 'playwright',
                                        page_number: currentPage
                                    });
                                }
                            } catch (error) {
                                console.log('Error extracting review:', error);
                            }
                        });
                        
                        return reviewsData;
                    });
                    
                    // Filter and add valid reviews
                    const validReviews = pageReviews.slice(0, maxReviews - totalCollected);
                    reviews.push(...validReviews);
                    totalCollected = reviews.length;
                    
                    crawlerLog.info(`Found ${validReviews.length} reviews on page ${currentPage}, total: ${totalCollected}`);
                    
                    // Check if we need more reviews and there's a next page
                    if (totalCollected < maxReviews) {
                        const hasNextPage = await page.evaluate(() => {
                            const nextButton = document.querySelector('a[aria-label*="Next"], .pagination a[rel="next"], a[href*="page="]');
                            return nextButton && !nextButton.classList.contains('disabled') && 
                                   !nextButton.hasAttribute('disabled');
                        });
                        
                        if (hasNextPage) {
                            const nextPageUrl = `${startUrl}?page=${currentPage + 1}`;
                            await crawler.addRequests([{
                                url: nextPageUrl,
                                userData: { page: currentPage + 1 }
                            }]);
                            crawlerLog.info(`Added next page: ${nextPageUrl}`);
                        } else {
                            crawlerLog.info('No more pages available');
                        }
                    }
                    
                } catch (error) {
                    crawlerLog.error(`Error processing page ${currentPage}: ${error.message}`);
                    
                    // Save error page for debugging
                    try {
                        const html = await page.content();
                        await Actor.setValue(`ERROR_PAGE_${currentPage}`, html, { 
                            contentType: 'text/html' 
                        });
                    } catch (saveError) {
                        crawlerLog.warning('Could not save error page');
                    }
                }
            },
        });
        
        await crawler.run([{
            url: startUrl,
            userData: { page: 1 }
        }]);
        
        // Save results
        log.info(`Successfully scraped ${reviews.length} reviews for ${company_name}`);
        
        if (reviews.length > 0) {
            await Actor.pushData(reviews);
        }
        
        await Actor.setValue('OUTPUT', {
            company: company_name,
            total_reviews: reviews.length,
            reviews: reviews,
            scraped_at: new Date().toISOString(),
            success: true,
            method_used: 'playwright'
        });
        
        log.info('Actor completed successfully');
        
    } catch (error) {
        log.error('Actor failed with error:', error);
        
        await Actor.setValue('ERROR_DETAILS', {
            error_message: error.message,
            error_stack: error.stack,
            timestamp: new Date().toISOString()
        });
        
        await Actor.setValue('OUTPUT', {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
        
        throw error;
    }
});