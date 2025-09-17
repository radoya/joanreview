import { Actor } from 'apify';
import { gotScraping } from 'got-scraping';

Actor.main(async () => {
    const { company_name, maxReviews = 20 } = await Actor.getInput();
    if (!company_name) {
        throw new Error('You must provide "company_name" input!');
    }

    const reviews = [];
    let page = 1;
    let totalCollected = 0;
    let hasMore = true;

    // Use a residential proxy for the best chance of success
    const proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US',
    });
    const proxyUrl = await proxyConfiguration.newUrl();

    while (totalCollected < maxReviews && hasMore) {
        // This is an internal API endpoint G2 uses to load reviews dynamically.
        // It's more stable than scraping the HTML page.
        const url = `https://www.g2.com/products/${company_name}/reviews.json?page=${page}`;

        try {
            const response = await gotScraping({
                url,
                proxyUrl,
                responseType: 'json',
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': `https://www.g2.com/products/${company_name}/reviews`,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                },
            });

            const { reviews: pageReviews, total_pages } = response.body;

            if (!pageReviews || pageReviews.length === 0) {
                hasMore = false;
                break;
            }

            for (const review of pageReviews) {
                if (totalCollected >= maxReviews) break;

                const reviewData = {
                    review_id: review.id,
                    review_title: review.title,
                    review_content: review.comment_text,
                    review_question_answers: review.review_answers?.map(qa => ({
                        question: qa.question_text,
                        answer: qa.answer_text,
                    })) || [],
                    review_rating: review.rating,
                    reviewer: {
                        reviewer_name: review.user_name,
                        reviewer_job_title: review.user_job_title,
                        reviewer_link: review.user_link ? `https://www.g2.com${review.user_link}` : null,
                    },
                    publish_date: review.submitted_at,
                    reviewer_company_size: review.company_segment,
                    video_link: review.video_url,
                    review_link: review.public_url ? `https://www.g2.com${review.public_url}` : null,
                };

                reviews.push(reviewData);
                totalCollected++;
            }

            if (page >= total_pages) {
                hasMore = false;
            }

            page++;
        } catch (error) {
            console.log(`Failed to fetch reviews from API: ${error.message}`);
            if (error.response) {
                console.log(`Status Code: ${error.response.statusCode}`);
                console.log(`Response Body: ${JSON.stringify(error.response.body)}`);
            }
            break;
        }
    }

    await Actor.pushData(reviews);
    console.log(`Scraped ${reviews.length} reviews for ${company_name}`);
});
