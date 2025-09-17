import { Actor, log } from 'apify';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import { gotScraping } from 'got-scraping';

// Disable aggressive memory optimization for Playwright
Configuration.set('memoryMbytes', 4096);
Configuration.set('systemInfoIntervalMillis', 60000);

Actor.main(async () => {
    const { company_name, maxReviews = 20, usePlaywright = true } = await Actor.getInput();
    if (!company_name) throw new Error('You must provide "company_name" input!');

    const startUrl = `https://www.g2.com/products/${company_name}/reviews`;

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    const reviews = [];
    let totalCollected = 0;

    // Try Playwright first (more reliable for heavily protected sites)
    if (usePlaywright) {
        log.info('Using Playwright crawler for better anti-bot evasion...');
        
        const crawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestsPerCrawl: Math.ceil(maxReviews / 10) + 1, // Estimate pages needed
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 120,
            maxConcurrency: 1, // Single concurrent request to avoid detection
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
                async ({ page, request }) => {
                    // Remove automation indicators
                    await page.evaluateOnNewDocument(() => {
                        Object.defineProperty(navigator, 'webdriver', {
                            get: () => undefined,
                        });
                        // Override chrome detection
                        window.chrome = {
                            runtime: {},
                        };
                        // Override permissions
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications' ?
                                Promise.resolve({ state: Notification.permission }) :
                                originalQuery(parameters)
                        );
                    });
                    
                    // Set realistic viewport
                    await page.setViewportSize({ width: 1920, height: 1080 });
                    
                    // Add extra headers
                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    });
                },
            ],
            requestHandler: async ({ request, page, log: crawlerLog }) => {
                const currentPage = request.userData.page || 1;
                crawlerLog.info(`Processing page ${currentPage} of ${company_name} reviews`);
                
                try {
                    // Wait for reviews to load with multiple fallback selectors
                    await page.waitForSelector('[data-test="review-card"], .paper--white, .review-card', {
                        timeout: 30000,
                    });
                    
                    // Additional wait to ensure dynamic content loads
                    await page.waitForTimeout(2000 + Math.random() * 2000);
                    
                    // Scroll to trigger lazy loading
                    await page.evaluate(() => {
                        window.scrollTo(0, document.body.scrollHeight / 2);
                    });
                    await page.waitForTimeout(1000);
                    await page.evaluate(() => {
                        window.scrollTo(0, document.body.scrollHeight);
                    });
                    await page.waitForTimeout(1500);
                    
                    // Extract reviews
                    const pageReviews = await page.evaluate(() => {
                        const reviewsData = [];
                        const reviewCards = document.querySelectorAll('[data-test="review-card"], .paper--white');
                        
                        reviewCards.forEach(card => {
                            // Try multiple selectors for each field
                            const reviewLinkEl = card.querySelector('a[data-test="review-card-link"], a[href*="/reviews/"]');
                            const reviewLink = reviewLinkEl ? reviewLinkEl.getAttribute('href') : '';
                            const reviewIdMatch = reviewLink.match(/-(\d+)$/);
                            
                            const titleEl = card.querySelector('[data-test="review-card-title"], h3, .h4');
                            const contentEl = card.querySelector('[data-test="review-card-content"], .formatted-text, .review-content');
                            const ratingEl = card.querySelector('[data-test="star-rating"], .stars, [data-rating]');
                            const dateEl = card.querySelector('time, [datetime]');
                            
                            const nameEl = card.querySelector('[data-test="reviewer-display-name"], .link--header, a[href*="/users/"]');
                            const jobEl = card.querySelector('[data-test="reviewer-job-title"], .mt-4th');
                            const sizeEl = card.querySelector('[data-test="reviewer-company-size"], .company-size');
                            
                            // Extract Q&A sections
                            const qaItems = [];
                            const qaElements = card.querySelectorAll('[data-test="review-answer"], .review-question-answer');
                            qaElements.forEach(qa => {
                                const questionEl = qa.querySelector('[data-test="review-question"], .fw-semibold, strong');
                                const answerEl = qa.querySelector('[data-test="review-text"], .formatted-text');
                                if (questionEl && answerEl) {
                                    qaItems.push({
                                        question: questionEl.textContent.trim(),
                                        answer: answerEl.textContent.trim()
                                    });
                                }
                            });
                            
                            const videoEl = card.querySelector('a[data-test="review-video-link"], a[href*="video"]');
                            
                            reviewsData.push({
                                review_id: reviewIdMatch ? Number(reviewIdMatch[1]) : null,
                                review_title: titleEl ? titleEl.textContent.trim() : null,
                                review_content: contentEl ? contentEl.textContent.trim() : null,
                                review_question_answers: qaItems,
                                review_rating: ratingEl ? (Number(ratingEl.getAttribute('data-rating')) || 
                                    Number(ratingEl.textContent.match(/\d+/)?.[0])) : null,
                                reviewer: {
                                    reviewer_name: nameEl ? nameEl.textContent.trim() : null,
                                    reviewer_job_title: jobEl ? jobEl.textContent.trim() : null,
                                    reviewer_link: nameEl && nameEl.getAttribute('href') ? 
                                        `https://www.g2.com${nameEl.getAttribute('href')}` : null,
                                },
                                publish_date: dateEl ? dateEl.getAttribute('datetime') : null,
                                reviewer_company_size: sizeEl ? sizeEl.textContent.trim() : null,
                                video_link: videoEl ? videoEl.getAttribute('href') : null,
                                review_link: reviewLink ? `https://www.g2.com${reviewLink}` : null,
                            });
                        });
                        
                        return reviewsData;
                    });
                    
                    // Filter and add valid reviews
                    const validReviews = pageReviews.filter(r => r.review_title || r.review_content);
                    reviews.push(...validReviews.slice(0, maxReviews - totalCollected));
                    totalCollected = reviews.length;
                    
                    crawlerLog.info(`Found ${validReviews.length} reviews on page ${currentPage}, total: ${totalCollected}`);
                    
                    // Check if we need more reviews and if there's a next page
                    if (totalCollected < maxReviews) {
                        const hasNextPage = await page.evaluate(() => {
                            const nextButton = document.querySelector('a[aria-label*="Next"], .pagination a[rel="next"]');
                            return nextButton && !nextButton.classList.contains('disabled');
                        });
                        
                        if (hasNextPage) {
                            const nextPageUrl = `${startUrl}?page=${currentPage + 1}`;
                            await crawler.addRequests([{
                                url: nextPageUrl,
                                userData: { page: currentPage + 1 }
                            }]);
                        }
                    }
                    
                } catch (error) {
                    crawlerLog.error(`Error processing page ${currentPage}: ${error.message}`);
                    
                    // Save page for debugging if it's the first page
                    if (currentPage === 1) {
                        const html = await page.content();
                        await Actor.setValue(`DEBUG_PAGE_${company_name}_p${currentPage}`, html, { 
                            contentType: 'text/html' 
                        });
                        
                        // Check if we hit a captcha or block page
                        const pageText = await page.evaluate(() => document.body.innerText);
                        if (pageText.includes('captcha') || pageText.includes('blocked') || pageText.includes('403')) {
                            crawlerLog.error('Detected captcha or block page. Consider using different proxy settings.');
                        }
                    }
                }
            },
        });
        
        await crawler.run([{
            url: startUrl,
            userData: { page: 1 }
        }]);
        
    } else {
        // Fallback to got-scraping with enhanced configuration
        log.info('Using got-scraping crawler...');
        
        let page = 1;
        let hasMore = true;
        
        while (totalCollected < maxReviews && hasMore && page <= 10) {
            const url = `${startUrl}?page=${page}`;
            const proxyUrl = await proxyConfiguration.newUrl();
            
            log.info(`Fetching ${url}`);
            
            // Add random delay between requests
            if (page > 1) {
                await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
            }
            
            try {
                const response = await gotScraping({
                    url,
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
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    },
                });
                
                if (response.statusCode !== 200) {
                    log.warning(`Non-200 status (${response.statusCode}) for ${url}`);
                    if (page === 1) {
                        await Actor.setValue(`ERROR_PAGE_${company_name}_p${page}`, response.body, { 
                            contentType: 'text/html' 
                        });
                    }
                    break;
                }
                
                // Parse HTML with cheerio (same as your original code)
                const $ = cheerio.load(response.body);
                const reviewCards = $('[data-test="review-card"]');
                
                if (reviewCards.length === 0) {
                    hasMore = false;
                    break;
                }
                
                // ... rest of your cheerio parsing logic ...
                
            } catch (err) {
                log.error(`Request failed for ${url}: ${err.message}`);
                if (err.message.includes('403') || err.message.includes('595')) {
                    log.info('Switching to Playwright due to anti-bot protection...');
                    // You could trigger Playwright here as fallback
                }
                break;
            }
            
            page++;
        }
    }
    
    // Save results
    await Actor.pushData(reviews);
    log.info(`Successfully scraped ${reviews.length} reviews for ${company_name}`);
    
    // Save summary
    await Actor.setValue('OUTPUT', {
        company: company_name,
        total_reviews: reviews.length,
        reviews: reviews,
        scraped_at: new Date().toISOString()
    });
});