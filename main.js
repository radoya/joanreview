import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset, sleep } from 'crawlee';

Actor.main(async () => {
    const { company_name, maxReviews = 20 } = await Actor.getInput();
    if (!company_name) throw new Error('You must provide "company_name" input!');

    const startUrl = `https://www.g2.com/products/${company_name}/reviews`;

    // Use residential proxies with proper configuration
    const proxyConfiguration = await Actor.createProxyConfiguration({ 
        groups: ['RESIDENTIAL'], 
        countryCode: 'US',
        // Consider using premium residential proxies if available
    });

    const reviews = [];
    let totalCollected = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 1, // Reduced to avoid rate limiting
        requestHandlerTimeoutSecs: 120,
        navigationTimeoutSecs: 60,
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { 
            maxPoolSize: 20,
            sessionOptions: {
                maxUsageCount: 5, // Rotate sessions more frequently
            }
        },
        // Enhanced browser fingerprint
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--window-size=1920,1080',
                ],
            },
        },
        browserPoolOptions: {
            useFingerprints: true, // Enable fingerprinting
            fingerprintOptions: {
                fingerprintGeneratorOptions: {
                    browsers: ['chrome'],
                    devices: ['desktop'],
                    operatingSystems: ['windows', 'macos'],
                },
            },
        },
        preNavigationHooks: [async ({ page, request, session }) => {
            // Set realistic viewport
            await page.setViewportSize({ 
                width: 1920, 
                height: 1080 
            });

            // Random delay to appear more human-like
            await sleep(Math.random() * 3000 + 2000);
        }],
        postNavigationHooks: [async ({ page }) => {
            // Remove webdriver detection - using Playwright's addInitScript
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                window.chrome = { runtime: {} };
                Object.defineProperty(navigator, 'permissions', {
                    get: () => ({
                        query: () => Promise.resolve({ state: 'granted' })
                    })
                });
            });
        }],
        requestHandler: async ({ page, request, session, crawler }) => {
            const url = request.url;
            log.info(`Opening ${url}`);

            try {
                // Navigate with more realistic behavior
                await page.goto(url, { 
                    waitUntil: 'networkidle',
                    timeout: 60000 
                });

                // Random delay after page load
                await sleep(Math.random() * 2000 + 1000);

                // Check for blocks or captchas
                const bodyText = await page.content();
                if (/captcha|unusual traffic|access denied|403/i.test(bodyText)) {
                    log.warning('Detected block or captcha, retiring session');
                    session.retire();
                    throw new Error('Blocked - captcha or access denied');
                }

                // Check if we're actually on the reviews page
                const pageTitle = await page.title();
                if (!pageTitle.includes('Reviews') && !pageTitle.includes(company_name)) {
                    log.warning('Not on expected page, might be redirected');
                    session.retire();
                    throw new Error('Redirected or blocked');
                }

                // Wait for reviews with better error handling
                try {
                    await page.waitForSelector('[data-test="review-card"]', { 
                        timeout: 20000 
                    });
                } catch (e) {
                    // Try alternative selectors
                    const hasReviews = await page.$('.paper.paper--white');
                    if (!hasReviews) {
                        log.warning('No reviews found on page');
                        return;
                    }
                }

                // Scroll to load all reviews (lazy loading)
                await page.evaluate(() => {
                    window.scrollTo(0, document.body.scrollHeight / 2);
                });
                await sleep(1000);
                await page.evaluate(() => {
                    window.scrollTo(0, document.body.scrollHeight);
                });
                await sleep(1500);

                // Extract reviews
                const pageReviews = await page.$$('[data-test="review-card"]');
                log.info(`Found ${pageReviews.length} reviews on current page`);

                for (const card of pageReviews) {
                    if (totalCollected >= maxReviews) break;

                    try {
                        const reviewData = await card.evaluate((el) => {
                            const getTextContent = (selector) => {
                                const elem = el.querySelector(selector);
                                return elem?.textContent?.trim() || null;
                            };

                            const getAttr = (selector, attr) => {
                                const elem = el.querySelector(selector);
                                return elem?.getAttribute(attr) || null;
                            };

                            // Extract review ID from link
                            const link = getAttr('a[data-test="review-card-link"]', 'href') || '';
                            const reviewIdMatch = link.match(/-(\d+)$/);
                            
                            return {
                                review_id: reviewIdMatch ? Number(reviewIdMatch[1]) : null,
                                review_title: getTextContent('[data-test="review-card-title"]'),
                                review_content: getTextContent('[data-test="review-card-content"]'),
                                review_rating: Number(getAttr('[data-test="star-rating"]', 'data-rating')) || null,
                                publish_date: getAttr('time', 'datetime'),
                                reviewer_name: getTextContent('[data-test="reviewer-display-name"]'),
                                reviewer_job_title: getTextContent('[data-test="reviewer-job-title"]'),
                                reviewer_link: (() => {
                                    const href = getAttr('[data-test="reviewer-display-name"]', 'href');
                                    return href ? `https://www.g2.com${href}` : null;
                                })(),
                                reviewer_company_size: getTextContent('[data-test="reviewer-company-size"]'),
                                video_link: getAttr('a[data-test="review-video-link"]', 'href'),
                                review_link: (() => {
                                    const href = getAttr('a[data-test="review-card-link"]', 'href');
                                    return href ? `https://www.g2.com${href}` : null;
                                })(),
                            };
                        });

                        // Extract Q&A separately
                        const review_question_answers = await card.$$eval('[data-test="review-answer"]', (nodes) => 
                            nodes.map((qa) => ({
                                question: qa.querySelector('[data-test="review-question"]')?.textContent?.trim() || '',
                                answer: qa.querySelector('[data-test="review-text"]')?.textContent?.trim() || '',
                            })).filter(x => x.question && x.answer)
                        ).catch(() => []);

                        reviews.push({
                            ...reviewData,
                            review_question_answers,
                            reviewer: {
                                reviewer_name: reviewData.reviewer_name,
                                reviewer_job_title: reviewData.reviewer_job_title,
                                reviewer_link: reviewData.reviewer_link,
                            }
                        });

                        totalCollected++;
                        log.info(`Collected review ${totalCollected}/${maxReviews}`);
                    } catch (error) {
                        log.warning(`Failed to extract review: ${error.message}`);
                    }
                }

                if (totalCollected >= maxReviews) {
                    log.info(`Reached max reviews limit: ${maxReviews}`);
                    return;
                }

                // Check for next page with better selectors
                const nextSelectors = [
                    'a[rel="next"]',
                    'a[aria-label="Next"]',
                    '.pagination__next:not(.disabled)',
                    'a.pagination-link[aria-label="Go to next page"]'
                ];

                let nextLink = null;
                for (const selector of nextSelectors) {
                    nextLink = await page.$(selector);
                    if (nextLink) break;
                }

                if (nextLink) {
                    const isDisabled = await nextLink.evaluate(el => 
                        el.classList.contains('disabled') || 
                        el.getAttribute('aria-disabled') === 'true'
                    );

                    if (!isDisabled) {
                        const nextHref = await nextLink.getAttribute('href');
                        if (nextHref) {
                            const nextUrl = nextHref.startsWith('http') ? 
                                nextHref : `https://www.g2.com${nextHref}`;
                            
                            // Add delay before next page
                            await sleep(Math.random() * 3000 + 2000);
                            
                            await crawler.addRequests([{ 
                                url: nextUrl,
                                uniqueKey: nextUrl 
                            }]);
                            
                            log.info(`Added next page to queue: ${nextUrl}`);
                        }
                    }
                }

            } catch (error) {
                log.error(`Error processing ${url}: ${error.message}`);
                
                // Take screenshot for debugging
                try {
                    const screenshot = await page.screenshot({ 
                        fullPage: true,
                        type: 'png' 
                    });
                    await Actor.setValue('error-screenshot', screenshot, { 
                        contentType: 'image/png' 
                    });
                } catch (screenshotError) {
                    log.warning(`Failed to take screenshot: ${screenshotError.message}`);
                }
                
                throw error;
            }
        },
        failedRequestHandler: async ({ request, error }) => {
            log.error(`Request failed ${request.url}: ${error.message}`);
            
            // If consistently failing, might need to adjust strategy
            if (request.retryCount >= 2) {
                log.warning(`Request failed multiple times. Consider using different proxy or adjusting crawling strategy.`);
            }
        },
        maxRequestRetries: 3,
        maxRequestsPerCrawl: 100,
    });

    await crawler.run([startUrl]);

    // Store results
    await Actor.pushData(reviews);
    
    log.info(`Successfully scraped ${reviews.length} reviews for ${company_name}`);
    log.info(`Reviews sample: ${JSON.stringify(reviews.slice(0, 2), null, 2)}`);

    // Store summary
    await Actor.setValue('OUTPUT', {
        company: company_name,
        total_reviews_scraped: reviews.length,
        scraping_date: new Date().toISOString(),
    });
});