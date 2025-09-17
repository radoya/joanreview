import { Actor, log } from 'apify';

Actor.main(async () => {
    try {
        log.info('Actor starting...');
        
        const input = await Actor.getInput();
        log.info('Input received:', input);
        
        if (!input) {
            throw new Error('No input provided to the actor');
        }
        
        const { company_name, maxReviews = 20 } = input;
        
        if (!company_name) {
            throw new Error('You must provide "company_name" input!');
        }
        
        log.info(`Starting scrape for company: ${company_name}, max reviews: ${maxReviews}`);
        
        // Import dependencies
        log.info('Loading dependencies...');
        
        let gotScraping, cheerio;
        
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
        let page = 1;
        const maxPages = Math.ceil(maxReviews / 10) + 1;
        
        while (totalCollected < maxReviews && page <= maxPages) {
            const url = page === 1 ? startUrl : `${startUrl}?page=${page}`;
            log.info(`Scraping page ${page}: ${url}`);
            
            try {
                const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
                log.info(`Using proxy: ${proxyUrl ? 'YES' : 'NO'}`);
                
                // Add random delay between requests
                if (page > 1) {
                    const delay = 3000 + Math.random() * 4000;
                    log.info(`Waiting ${Math.round(delay)}ms before next request...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
                const response = await gotScraping({
                    url,
                    proxyUrl,
                    timeout: { request: 60000 },
                    retry: { limit: 3, methods: ['GET'] },
                    http2: true,
                    headerGeneratorOptions: {
                        browsers: [
                            { name: 'chrome', minVersion: 120, maxVersion: 130 },
                            { name: 'firefox', minVersion: 120, maxVersion: 130 },
                            { name: 'edge', minVersion: 120, maxVersion: 130 }
                        ],
                        devices: ['desktop'],
                        operatingSystems: ['windows', 'macos', 'linux'],
                        locales: ['en-US', 'en-GB'],
                    },
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Cache-Control': 'max-age=0',
                        'Sec-Ch-Ua': '"Chromium";v="120", "Not_A Brand";v="8", "Google Chrome";v="120"',
                        'Sec-Ch-Ua-Mobile': '?0',
                        'Sec-Ch-Ua-Platform': '"Windows"',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': page === 1 ? 'none' : 'same-origin',
                        'Sec-Fetch-User': page === 1 ? '?1' : undefined,
                        'Upgrade-Insecure-Requests': '1',
                        'Referer': page === 1 ? 'https://www.google.com/' : `https://www.g2.com/products/${company_name}/reviews`,
                        'DNT': '1',
                    },
                });
                
                log.info(`Response status: ${response.statusCode}, Content-Type: ${response.headers['content-type']}`);
                
                if (response.statusCode === 403) {
                    log.error('Got 403 Forbidden - G2.com is blocking requests');
                    await Actor.setValue('BLOCKED_RESPONSE', {
                        status: response.statusCode,
                        headers: response.headers,
                        bodyPreview: response.body.substring(0, 1000),
                        url: url,
                        page: page
                    });
                    
                    // Try one more time with different headers after longer delay
                    if (page === 1) {
                        log.info('Retrying with different approach...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        
                        const retryResponse = await gotScraping({
                            url,
                            proxyUrl: proxyConfiguration ? await proxyConfiguration.newUrl() : undefined,
                            timeout: { request: 30000 },
                            retry: { limit: 1 },
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                'Accept-Language': 'en-US,en;q=0.5',
                                'Connection': 'keep-alive',
                                'Upgrade-Insecure-Requests': '1',
                            },
                        });
                        
                        if (retryResponse.statusCode === 200) {
                            response.statusCode = retryResponse.statusCode;
                            response.body = retryResponse.body;
                            log.info('Retry successful!');
                        } else {
                            throw new Error(`Still blocked after retry: HTTP ${retryResponse.statusCode}`);
                        }
                    } else {
                        throw new Error(`HTTP ${response.statusCode}: G2.com blocked the request`);
                    }
                }
                
                if (response.statusCode !== 200) {
                    throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
                }
                
                const $ = cheerio.load(response.body);
                
                // Debug: Save page sample
                if (page === 1) {
                    await Actor.setValue('PAGE_SAMPLE', response.body.substring(0, 3000));
                }
                
                // Try multiple selectors for review cards
                let reviewCards = $('[data-test="review-card"]');
                if (reviewCards.length === 0) {
                    reviewCards = $('.paper--white');
                }
                if (reviewCards.length === 0) {
                    reviewCards = $('.review-card');
                }
                if (reviewCards.length === 0) {
                    reviewCards = $('[class*="review"][class*="card"]');
                }
                if (reviewCards.length === 0) {
                    reviewCards = $('[data-testid*="review"]');
                }
                
                log.info(`Found ${reviewCards.length} potential review cards on page ${page}`);
                
                if (reviewCards.length === 0) {
                    log.warning('No review cards found. Checking page structure...');
                    
                    // Debug: Check what's actually on the page
                    const pageTitle = $('title').text();
                    const h1Text = $('h1').text();
                    log.info(`Page title: "${pageTitle}", H1: "${h1Text}"`);
                    
                    // Look for any text that might indicate reviews
                    const bodyText = $('body').text();
                    const hasReviewText = bodyText.includes('review') || bodyText.includes('Review');
                    log.info(`Page contains review text: ${hasReviewText}`);
                    
                    if (page === 1 && !hasReviewText) {
                        log.error('This might not be a valid G2 reviews page or the page structure has changed');
                    }
                    
                    break; // No reviews found, stop pagination
                }
                
                let pageReviewCount = 0;
                
                reviewCards.each((index, element) => {
                    if (totalCollected >= maxReviews) return false;
                    
                    const $card = $(element);
                    
                    // Try multiple selectors for title
                    let title = $card.find('[data-test="review-card-title"]').first().text().trim();
                    if (!title) title = $card.find('h3, h4, .h4').first().text().trim();
                    if (!title) title = $card.find('[class*="title"]').first().text().trim();
                    
                    // Try multiple selectors for content
                    let content = $card.find('[data-test="review-card-content"]').first().text().trim();
                    if (!content) content = $card.find('.formatted-text').first().text().trim();
                    if (!content) content = $card.find('.review-content, p').first().text().trim();
                    if (!content) content = $card.find('[class*="content"]').first().text().trim();
                    
                    // Try to find rating
                    let rating = null;
                    const ratingEl = $card.find('[data-test="star-rating"], .stars, [data-rating]').first();
                    if (ratingEl.length) {
                        rating = ratingEl.attr('data-rating') || ratingEl.text().match(/\d+/)?.[0];
                        if (rating) rating = Number(rating);
                    }
                    
                    // Try to find reviewer name
                    let reviewerName = $card.find('[data-test="reviewer-display-name"]').first().text().trim();
                    if (!reviewerName) reviewerName = $card.find('a[href*="/users/"]').first().text().trim();
                    if (!reviewerName) reviewerName = $card.find('.link--header').first().text().trim();
                    
                    // Only add if we have meaningful content
                    if (title || content) {
                        reviews.push({
                            review_id: totalCollected + 1,
                            review_title: title || null,
                            review_content: content || null,
                            review_rating: rating,
                            reviewer_name: reviewerName || null,
                            page_found: page,
                            scraped_from: 'got-scraping',
                            scraped_at: new Date().toISOString()
                        });
                        totalCollected++;
                        pageReviewCount++;
                    }
                });
                
                log.info(`Extracted ${pageReviewCount} valid reviews from page ${page}, total: ${totalCollected}`);
                
                // Check if there are more pages
                if (totalCollected < maxReviews) {
                    const hasNextPage = $('.pagination a[rel="next"]').length > 0 && 
                                       !$('.pagination a[rel="next"]').hasClass('disabled');
                    
                    if (!hasNextPage) {
                        log.info('No more pages available');
                        break;
                    }
                } else {
                    log.info('Reached maximum number of reviews');
                    break;
                }
                
            } catch (error) {
                log.error(`Failed to scrape page ${page}: ${error.message}`);
                
                if (error.message.includes('403') || error.message.includes('blocked')) {
                    log.error('G2.com is blocking requests. Consider using a different approach or Playwright.');
                    break;
                } else if (page === 1) {
                    // If first page fails for other reasons, still throw
                    throw error;
                } else {
                    // For subsequent pages, log error but continue
                    log.warning(`Skipping page ${page} due to error: ${error.message}`);
                }
            }
            
            page++;
        }
        
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
            method_used: 'got-scraping'
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