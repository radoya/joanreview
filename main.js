import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

Actor.main(async () => {
    const input = await Actor.getInput();
    const {
        company_name,
        maxReviews = 20,
        use_api_wrapper = false,
        api_url_template = '',
        api_key = '',
        pageSize = 50,
    } = input || {};

    if (!company_name) throw new Error('You must provide "company_name" input!');

    const reviews = [];

    // Helper to push and check limit
    const pushReview = (review) => {
        if (reviews.length < maxReviews) reviews.push(review);
    };

    // If API wrapper is enabled and template provided, use it
    if (use_api_wrapper && api_url_template) {
        log.info('Using API wrapper mode');
        let page = 1;
        let totalCollected = 0;
        let hasMore = true;

        // Map API items to our schema as flexibly as possible
        const mapItem = (item) => {
            const get = (paths) => paths.reduce((val, p) => (val !== undefined && val !== null) ? val : item?.[p], undefined);
            const nestedGet = (obj, pathArr) => pathArr.reduce((o, p) => (o && o[p] !== undefined) ? o[p] : undefined, obj);

            const review_id = get(['review_id', 'id']);
            const review_title = get(['review_title', 'title']);
            const review_content = get(['review_content', 'comment_text', 'content', 'text']);
            const review_rating = Number(get(['review_rating', 'rating', 'stars'])) || null;
            const publish_date = get(['publish_date', 'submitted_at', 'date']);

            const reviewer_name = get(['reviewer_name', 'user_name', 'author_name', 'reviewer']);
            const reviewer_job_title = get(['reviewer_job_title', 'user_job_title', 'job_title']);
            const reviewer_link = get(['reviewer_link', 'user_link', 'profile_url']);
            const reviewer_company_size = get(['reviewer_company_size', 'company_segment', 'company_size']);
            const video_link = get(['video_link', 'video_url']);
            const review_link = get(['review_link', 'public_url', 'url']);

            const qa = get(['review_question_answers'])
                || nestedGet(item, ['qa'])
                || [];

            const review_question_answers = Array.isArray(qa)
                ? qa.map((q) => ({
                    question: q.question || q.question_text || q.q || null,
                    answer: q.answer || q.answer_text || q.a || null,
                })).filter((x) => x.question && x.answer)
                : [];

            return {
                review_id: review_id ?? null,
                review_title: review_title ?? null,
                review_content: review_content ?? null,
                review_question_answers,
                review_rating,
                reviewer: {
                    reviewer_name: reviewer_name ?? null,
                    reviewer_job_title: reviewer_job_title ?? null,
                    reviewer_link: reviewer_link ? (reviewer_link.startsWith('http') ? reviewer_link : `https://www.g2.com${reviewer_link}`) : null,
                },
                publish_date: publish_date ?? null,
                reviewer_company_size: reviewer_company_size ?? null,
                video_link: video_link ?? null,
                review_link: review_link ? (review_link.startsWith('http') ? review_link : `https://www.g2.com${review_link}`) : null,
            };
        };

        while (totalCollected < maxReviews && hasMore) {
            const tpl = api_url_template
                .replace('{product}', encodeURIComponent(company_name))
                .replace('{page}', String(page))
                .replace('{limit}', String(pageSize));

            log.info(`API request: ${tpl}`);
            try {
                const resp = await gotScraping({
                    url: tpl,
                    responseType: 'json',
                    timeout: { request: 45000 },
                    retry: { limit: 2 },
                    headers: api_key ? {
                        'Authorization': `Bearer ${api_key}`,
                        'x-api-key': api_key,
                        'Accept': 'application/json',
                    } : { 'Accept': 'application/json' },
                });

                if (resp.statusCode !== 200) {
                    log.warning(`API non-200 (${resp.statusCode})`);
                    await Actor.setValue(`API_ERROR_${company_name}_p${page}.json`, resp.body, { contentType: 'application/json' });
                    break;
                }

                const body = resp.body;
                // Accept a few common shapes
                const items = Array.isArray(body)
                    ? body
                    : Array.isArray(body?.reviews) ? body.reviews
                    : Array.isArray(body?.data) ? body.data
                    : [];

                if (!items.length) {
                    hasMore = false;
                    break;
                }

                for (const it of items) {
                    if (totalCollected >= maxReviews) break;
                    pushReview(mapItem(it));
                    totalCollected++;
                }

                // Pagination: prefer total_pages if present, otherwise continue while items returned == pageSize
                const total_pages = Number(body?.total_pages) || null;
                if (total_pages) {
                    hasMore = page < total_pages && totalCollected < maxReviews;
                } else {
                    hasMore = items.length >= pageSize && totalCollected < maxReviews;
                }
                page++;
            } catch (e) {
                log.error(`API request failed: ${e.message}`);
                if (e?.response?.body) await Actor.setValue(`API_ERROR_${company_name}_p${page}.json`, e.response.body, { contentType: 'application/json' });
                break;
            }
        }

        await Actor.pushData(reviews);
        log.info(`Scraped ${reviews.length} reviews for ${company_name} (API mode)`);
        return;
    }

    // Fallback: HTML scraping using got-scraping + cheerio
    const startUrl = `https://www.g2.com/products/${company_name}/reviews`;

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

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