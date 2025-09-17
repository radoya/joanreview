import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

Actor.main(async () => {
    const { company_name, maxReviews = 20 } = await Actor.getInput();
    if (!company_name) throw new Error('You must provide "company_name" input!');

    const startUrl = `https://www.g2.com/products/${company_name}/reviews`;

    // Use Apify Proxy in AUTO mode (Datacenter by default unless overridden in run settings)
    const proxyConfiguration = await Actor.createProxyConfiguration();

    const reviews = [];
    let totalCollected = 0;
    let page = 1;
    let hasMore = true;

    while (totalCollected < maxReviews && hasMore) {
        const url = `${startUrl}?page=${page}`;
        const proxyUrl = await proxyConfiguration.newUrl();

        log.info(`Fetching ${url}`);
        let html = '';
        try {
            const response = await gotScraping({
                url,
                proxyUrl,
                timeout: { request: 45000 },
                retry: { limit: 2 },
                http2: false,
                headerGeneratorOptions: {
                    browsers: [{ name: 'chrome', minVersion: 120 }],
                    devices: ['desktop'],
                    operatingSystems: ['windows', 'macos'],
                },
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Upgrade-Insecure-Requests': '1',
                    'Referer': `https://www.g2.com/products/${company_name}`,
                },
            });

            if (response.statusCode !== 200) {
                log.warning(`Non-200 (${response.statusCode}) for ${url}`);
                if (page === 1) await Actor.setValue(`ERROR_PAGE_${company_name}_p${page}`, response.body, { contentType: 'text/html' });
                break;
            }
            html = response.body;
        } catch (err) {
            log.warning(`Request failed for ${url}: ${(err && err.message) || err}`);
            if (page === 1 && err?.response?.body) {
                await Actor.setValue(`ERROR_PAGE_${company_name}_p${page}`, err.response.body, { contentType: 'text/html' });
            }
            break;
        }

        const $ = cheerio.load(html);
        const reviewCards = $('[data-test="review-card"]');
        if (reviewCards.length === 0) {
            if (page === 1) {
                await Actor.setValue(`EMPTY_PAGE_${company_name}_p${page}`, html, { contentType: 'text/html' });
                log.info(`No review cards found on first page: ${url}`);
            }
            hasMore = false;
            break;
        }

        reviewCards.each((_, el) => {
            if (totalCollected >= maxReviews) return;

            const reviewLink = $(el).find('a[data-test="review-card-link"]').attr('href') || '';
            const reviewIdMatch = reviewLink.match(/-(\d+)$/);
            const review_id = reviewIdMatch ? Number(reviewIdMatch[1]) : null;

            const review_title = $(el).find('[data-test="review-card-title"]').text().trim() || null;
            const review_content = $(el).find('[data-test="review-card-content"]').text().trim() || null;
            const review_rating = Number($(el).find('[data-test="star-rating"]').attr('data-rating')) || null;
            const publish_date = $(el).find('time').attr('datetime') || null;

            const reviewer_name = $(el).find('[data-test="reviewer-display-name"]').text().trim() || null;
            const reviewer_job_title = $(el).find('[data-test="reviewer-job-title"]').text().trim() || null;
            const reviewer_link = $(el).find('[data-test="reviewer-display-name"]').attr('href')
                ? `https://www.g2.com${$(el).find('[data-test="reviewer-display-name"]').attr('href')}`
                : null;
            const reviewer_company_size = $(el).find('[data-test="reviewer-company-size"]').text().trim() || null;

            const review_question_answers = [];
            $(el).find('[data-test="review-answer"]').each((_, qa) => {
                const question = $(qa).find('[data-test="review-question"]').text().trim();
                const answer = $(qa).find('[data-test="review-text"]').text().trim();
                if (question && answer) review_question_answers.push({ question, answer });
            });

            const video_link = $(el).find('a[data-test="review-video-link"]').attr('href') || null;

            reviews.push({
                review_id,
                review_title,
                review_content,
                review_question_answers,
                review_rating,
                reviewer: {
                    reviewer_name,
                    reviewer_job_title,
                    reviewer_link,
                },
                publish_date,
                reviewer_company_size,
                video_link,
                review_link: reviewLink ? `https://www.g2.com${reviewLink}` : null,
            });

            totalCollected++;
        });

        page++;
    }

    await Actor.pushData(reviews);
    log.info(`Scraped ${reviews.length} reviews for ${company_name}`);
});