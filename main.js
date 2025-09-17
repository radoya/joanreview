import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset, sleep } from 'crawlee';

Actor.main(async () => {
    const { company_name, maxReviews = 20 } = await Actor.getInput();
    if (!company_name) throw new Error('You must provide "company_name" input!');

    const startUrl = `https://www.g2.com/products/${company_name}/reviews`;

    const proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'], countryCode: 'US' });

    const reviews = [];
    let totalCollected = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxConcurrency: 2,
        requestHandlerTimeoutSecs: 120,
        navigationTimeoutSecs: 60,
        // Rotate sessions and retry when blocked
        useSessionPool: true,
        persistCookiesPerSession: true,
        sessionPoolOptions: { maxPoolSize: 20 },
        preNavigationHooks: [async ({ page, request }) => {
            await page.setViewportSize({ width: 1366, height: 768 });
            await page.route('**/*', (route) => {
                const headers = {
                    ...route.request().headers(),
                    'accept-language': 'en-US,en;q=0.9',
                    'upgrade-insecure-requests': '1',
                    referer: `https://www.g2.com/products/${company_name}`,
                };
                route.continue({ headers });
            });
        }],
        requestHandler: async ({ page, request, session }) => {
            // If page shows captcha or block, retire session and retry
            const url = request.url;
            log.info(`Opening ${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded' });

            // Detect soft-blocks (captcha, access denied, blank body)
            const bodyText = await page.content();
            if (/captcha|unusual traffic|access denied/i.test(bodyText)) {
                log.warning('Detected block or captcha, retiring session');
                session.retire();
                throw new Error('Blocked');
            }

            // Wait for reviews or pagination
            await page.waitForSelector('[data-test="review-card"], [data-test="pagination"]', { timeout: 30000 });

            // Extract reviews on current page
            const pageReviews = await page.$$('[data-test="review-card"]');
            if (pageReviews.length === 0) {
                log.info('No review cards detected on this page.');
            }

            for (const card of pageReviews) {
                if (totalCollected >= maxReviews) break;

                const review_id = await card.evaluate((el) => {
                    const link = el.querySelector('a[data-test="review-card-link"]')?.getAttribute('href') || '';
                    const m = link.match(/-(\d+)$/);
                    return m ? Number(m[1]) : null;
                });
                const review_title = await card.$eval('[data-test="review-card-title"]', el => el.textContent?.trim() || '').catch(() => null);
                const review_content = await card.$eval('[data-test="review-card-content"]', el => el.textContent?.trim() || '').catch(() => null);
                const review_rating = await card.$eval('[data-test="star-rating"]', el => Number(el.getAttribute('data-rating')) || null).catch(() => null);
                const publish_date = await card.$eval('time', el => el.getAttribute('datetime')).catch(() => null);
                const reviewer_name = await card.$eval('[data-test="reviewer-display-name"]', el => el.textContent?.trim() || '').catch(() => null);
                const reviewer_job_title = await card.$eval('[data-test="reviewer-job-title"]', el => el.textContent?.trim() || '').catch(() => null);
                const reviewer_link = await card.$eval('[data-test="reviewer-display-name"]', el => {
                    const href = el.getAttribute('href');
                    return href ? `https://www.g2.com${href}` : null;
                }).catch(() => null);
                const reviewer_company_size = await card.$eval('[data-test="reviewer-company-size"]', el => el.textContent?.trim() || null).catch(() => null);

                const review_question_answers = await card.$$eval('[data-test="review-answer"]', (nodes) => nodes.map((qa) => ({
                    question: qa.querySelector('[data-test="review-question"]')?.textContent?.trim() || '',
                    answer: qa.querySelector('[data-test="review-text"]')?.textContent?.trim() || '',
                })).filter(x => x.question && x.answer));

                const video_link = await card.$eval('a[data-test="review-video-link"]', el => el.getAttribute('href')).catch(() => null);
                const review_link = await card.$eval('a[data-test="review-card-link"]', el => {
                    const href = el.getAttribute('href');
                    return href ? `https://www.g2.com${href}` : null;
                }).catch(() => null);

                reviews.push({
                    review_id,
                    review_title,
                    review_content,
                    review_question_answers,
                    review_rating,
                    reviewer: { reviewer_name, reviewer_job_title, reviewer_link },
                    publish_date,
                    reviewer_company_size,
                    video_link,
                    review_link,
                });

                totalCollected++;
            }

            if (totalCollected >= maxReviews) return;

            // Navigate to next page if exists
            const nextLink = await page.$('a[rel="next"], a[aria-label="Next"]');
            if (nextLink) {
                const nextHref = await nextLink.getAttribute('href');
                if (nextHref) await crawler.addRequests([{ url: `https://www.g2.com${nextHref}` }]);
            }
        },
        failedRequestHandler: async ({ request, error }) => {
            log.error(`Request failed ${request.url}: ${error.message}`);
        },
    });

    await crawler.run([startUrl]);

    await Actor.pushData(reviews);
    log.info(`Scraped ${reviews.length} reviews for ${company_name}`);
});
