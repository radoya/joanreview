# G2 Reviews Scraper

"""
This Apify Actor scrapes reviews from G2 (https://www.g2.com) 
for a given company and outputs them in structured JSON format.
"""

# ======================
# 📥 Input Example
# ======================

input_example = {
    "company_name": "joan",
    "maxReviews": 10
}

"""
- company_name → The company slug from the G2 URL.
  Example: "hubspot", "slack", or "joan".
- maxReviews → Maximum number of reviews to scrape. Default: 20.
"""

# ======================
# 📤 Output Example
# ======================

output_example = [
    {
        "review_id": 10549243,
        "review_title": "MMAL's Joan Meeting System",
        "review_content": "What do you like best about Joan?...",
        "review_question_answers": [
            {
                "question": "What do you like best about Joan?",
                "answer": "The best part I would like mention about..."
            },
            {
                "question": "What do you dislike about Joan?",
                "answer": "When we are setting up a device..."
            },
            {
                "question": "What problems is Joan solving and how is that benefiting you?",
                "answer": "All the other users have the visibility..."
            }
        ],
        "review_rating": 5,
        "reviewer": {
            "reviewer_name": "Dasith R.",
            "reviewer_job_title": "Infrastructure Lead Engineer",
            "reviewer_link": "https://www.g2.com/users/45a56834-fd90-4a06-be46-84ff3069b9b6"
        },
        "publish_date": "2024-11-21T00:00:00",
        "reviewer_company_size": "Mid-Market(51-1000 emp.)",
        "video_link": None,
        "review_link": "https://www.g2.com/products/joan/reviews/joan-review-10549243"
    }
]

"""
Each review includes:
- review_id
- review_title
- review_content
- review_question_answers (array of question → answer pairs)
- review_rating
- reviewer { name, job_title, profile_link }
- publish_date
- reviewer_company_size
- video_link (if available)
- review_link
"""

# ======================
# 🛠 Local Development
# ======================

"""
1. Clone the repo:
   git clone https://github.com/your-username/g2-reviews-actor.git
   cd g2-reviews-actor

2. Install dependencies:
   npm install

3. Run locally:
   apify run
"""

# ======================
# 🚀 Deploy to Apify Platform
# ======================

"""
1. Install Apify CLI:
   npm install -g apify-cli

2. Log in:
   apify login

3. Deploy:
   apify push

After deployment, you can run the Actor directly from your Apify account.
"""