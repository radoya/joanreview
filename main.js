import { Actor, log } from 'apify';
import * as cheerio from 'cheerio';
import { gotScraping } from 'got-scraping';

Actor.main(async () => {
    const { company_name, maxReviews = 20 } = await Actor.getInput();
    if (!company_name) throw new Error('You must provide "company_name" input!');

    const startUrl = `https://www.g2.com/products/${company_name}/reviews`;

    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });

    const reviews = [];
    let totalCollected = 0;
    let page = 1;
    let hasMore = true;

    // Helper to try JSON endpoint
    const tryJsonEndpoint = async (p, proxyUrl) => {
        const apiUrl = `https://www.g2.com/products/${company_name}/reviews.json?page=${p}`;
        try {
            const resp = await gotScraping({
                url: apiUrl,
                proxyUrl,
                timeout: { request: 30000 },
                retry: { limit: 1 },
                http2: false,
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': startUrl,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                responseType: 'json',
                throwHttpErrors: false,
            });
            if (resp.statusCode !== 200 || !resp.body) return { items: [], totalPages: 0 };
            const body = resp.body;
            const items = Array.isArray(body?.reviews) ? body.reviews : Array.isArray(body) ? body : [];
            const totalPages = Number(body?.total_pages) || 0;
            return { items, totalPages };
        } catch {
            return { items: [], totalPages: 0 };
        }
    };

    while (totalCollected < maxReviews && hasMore) {
        const url = `${startUrl}?page=${page}`;
        const proxyUrl = await proxyConfiguration.newUrl();

        log.info(`Fetching ${url}`);
        let html = '';
        let usedJsonFallback = false;
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
                throwHttpErrors: false,
            });

            if (response.statusCode !== 200) {
                log.warning(`Non-200 (${response.statusCode}) for ${url}`);
                if (page === 1) await Actor.setValue(`ERROR_PAGE_${company_name}_p${page}`, response.body, { contentType: 'text/html' });
                // Try JSON fallback
                const { items, totalPages } = await tryJsonEndpoint(page, proxyUrl);
                if (!items.length) break;
                for (const it of items) {
                    if (totalCollected >= maxReviews) break;
                    const review_link = it.public_url || it.url || '';
                    const idMatch = (review_link || '').match(/-(\d+)$/);
                    reviews.push({
                        review_id: idMatch ? Number(idMatch[1]) : (it.id ?? null),
                        review_title: it.title ?? null,
                        review_content: it.comment_text ?? it.content ?? null,
                        review_question_answers: Array.isArray(it.review_answers) ? it.review_answers.map((qa) => ({
                            question: qa.question_text,
                            answer: qa.answer_text,
                        })).filter(x => x.question && x.answer) : [],
                        review_rating: Number(it.rating) || null,
                        reviewer: {
                            reviewer_name: it.user_name ?? null,
                            reviewer_job_title: it.user_job_title ?? null,
                            reviewer_link: it.user_link ? `https://www.g2.com${it.user_link}` : null,
                        },
                        publish_date: it.submitted_at ?? null,
                        reviewer_company_size: it.company_segment ?? null,
                        video_link: it.video_url ?? null,
                        review_link: review_link ? (review_link.startsWith('http') ? review_link : `https://www.g2.com${review_link}`) : null,
                    });
                    totalCollected++;
                }
                if (totalPages && page >= totalPages) hasMore = false;
                usedJsonFallback = true;
            } else {
                html = response.body;
            }
        } catch (err) {
            log.warning(`Request failed for ${url}: ${(err && err.message) || err}`);
            if (page === 1 && err?.response?.body) {
                await Actor.setValue(`ERROR_PAGE_${company_name}_p${page}`, err.response.body, { contentType: 'text/html' });
            }
            // Try JSON fallback
            const { items } = await tryJsonEndpoint(page, proxyUrl);
            if (!items.length) break;
            for (const it of items) {
                if (totalCollected >= maxReviews) break;
                const review_link = it.public_url || it.url || '';
                const idMatch = (review_link || '').match(/-(\d+)$/);
                reviews.push({
                    review_id: idMatch ? Number(idMatch[1]) : (it.id ?? null),
                    review_title: it.title ?? null,
                    review_content: it.comment_text ?? it.content ?? null,
                    review_question_answers: Array.isArray(it.review_answers) ? it.review_answers.map((qa) => ({
                        question: qa.question_text,
                        answer: qa.answer_text,
                    })).filter(x => x.question && x.answer) : [],
                    review_rating: Number(it.rating) || null,
                    reviewer: {
                        reviewer_name: it.user_name ?? null,
                        reviewer_job_title: it.user_job_title ?? null,
                        reviewer_link: it.user_link ? `https://www.g2.com${it.user_link}` : null,
                    },
                    publish_date: it.submitted_at ?? null,
                    reviewer_company_size: it.company_segment ?? null,
                    video_link: it.video_url ?? null,
                    review_link: review_link ? (review_link.startsWith('http') ? review_link : `https://www.g2.com${review_link}`) : null,
                });
                totalCollected++;
            }
            usedJsonFallback = true;
        }

        if (!usedJsonFallback) {
            const $ = cheerio.load(html);
            const reviewCards = $('[data-test="review-card"]');
            if (reviewCards.length === 0) {
                if (page === 1) {
                    await Actor.setValue(`EMPTY_PAGE_${company_name}_p${page}`, html, { contentType: 'text/html' });
                    // As a last attempt, try JSON once
                    const { items } = await tryJsonEndpoint(page, proxyUrl);
                    if (!items.length) {
                        log.info(`No review cards found on first page: ${url}`);
                        hasMore = false;
                        break;
                    }
                    for (const it of items) {
                        if (totalCollected >= maxReviews) break;
                        const review_link = it.public_url || it.url || '';
                        const idMatch = (review_link || '').match(/-(\d+)$/);
                        reviews.push({
                            review_id: idMatch ? Number(idMatch[1]) : (it.id ?? null),
                            review_title: it.title ?? null,
                            review_content: it.comment_text ?? it.content ?? null,
                            review_question_answers: Array.isArray(it.review_answers) ? it.review_answers.map((qa) => ({
                                question: qa.question_text,
                                answer: qa.answer_text,
                            })).filter(x => x.question && x.answer) : [],
                            review_rating: Number(it.rating) || null,
                            reviewer: {
                                reviewer_name: it.user_name ?? null,
                                reviewer_job_title: it.user_job_title ?? null,
                                reviewer_link: it.user_link ? `https://www.g2.com${it.user_link}` : null,
                            },
                            publish_date: it.submitted_at ?? null,
                            reviewer_company_size: it.company_segment ?? null,
                            video_link: it.video_url ?? null,
                            review_link: review_link ? (review_link.startsWith('http') ? review_link : `https://www.g2.com${review_link}`) : null,
                        });
                        totalCollected++;
                    }
                } else {
                    hasMore = false;
                    break;
                }
            } else {
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
            }
        }

        page++;
        if (totalCollected >= maxReviews) hasMore = false;
    }

    await Actor.pushData(reviews);
    log.info(`Scraped ${reviews.length} reviews for ${company_name}`);
});