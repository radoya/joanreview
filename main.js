import { Actor } from 'apify';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

Actor.main(async () => {
    const { company_name, maxReviews = 20 } = await Actor.getInput();
    if (!company_name) {
        throw new Error('You must provide "company_name" input!');
    }

    const reviews = [];
    let page = 1;
    let totalCollected = 0;
    let hasMore = true;

    while (totalCollected < maxReviews && hasMore) {
        const url = `https://www.g2.com/products/${company_name}/reviews?page=${page}`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': `https://www.g2.com/products/${company_name}`,
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Dest': 'document',
            },
        });

        if (!response.ok) {
            const body = await response.text();
            await Actor.setValue(`ERROR_PAGE_${company_name}_p${page}`, body, { contentType: 'text/html' });
            console.log(`Request failed ${response.status} for ${url}`);
            break;
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        const reviewCards = $('[data-test="review-card"]');
        if (reviewCards.length === 0) {
            if (page === 1) {
                await Actor.setValue(`EMPTY_PAGE_${company_name}_p${page}`, html, { contentType: 'text/html' });
                console.log(`No review cards found on first page: ${url}`);
            }
            hasMore = false;
            break;
        }

        reviewCards.each((_, el) => {
            if (totalCollected >= maxReviews) return;

            // Review ID from review link
            const reviewLink = $(el).find('a[data-test="review-card-link"]').attr('href');
            const reviewIdMatch = reviewLink ? reviewLink.match(/-(\d+)$/) : null;
            const review_id = reviewIdMatch ? Number(reviewIdMatch[1]) : null;

            // Review metadata
            const review_title = $(el).find('[data-test="review-card-title"]').text().trim();
            const review_content = $(el).find('[data-test="review-card-content"]').text().trim();
            const review_rating = Number($(el).find('[data-test="star-rating"]').attr('data-rating')) || null;
            const publish_date = $(el).find('time').attr('datetime');

            // Reviewer details
            const reviewer_name = $(el).find('[data-test="reviewer-display-name"]').text().trim();
            const reviewer_job_title = $(el).find('[data-test="reviewer-job-title"]').text().trim();
            const reviewer_link = $(el).find('[data-test="reviewer-display-name"]').attr('href')
                ? `https://www.g2.com${$(el).find('[data-test="reviewer-display-name"]').attr('href')}`
                : null;
            const reviewer_company_size = $(el).find('[data-test="reviewer-company-size"]').text().trim() || null;

            // Review Q&A (best/dislike/problems solved)
            const review_question_answers = [];
            $(el).find('[data-test="review-answer"]').each((_, qa) => {
                const question = $(qa).find('[data-test="review-question"]').text().trim();
                const answer = $(qa).find('[data-test="review-text"]').text().trim();
                if (question && answer) {
                    review_question_answers.push({ question, answer });
                }
            });

            // Video link (optional)
            const video_link = $(el).find('a[data-test="review-video-link"]').attr('href') || null;

            reviews.push({
                review_id,
                review_title,
                review_content,
                review_question_answers,
                review_rating,
                reviewer: {
                    reviewer_name,
                    reviewer_job_title: reviewer_job_title || null,
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
    console.log(`Scraped ${reviews.length} reviews for ${company_name}`);
});
