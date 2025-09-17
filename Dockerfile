FROM apify/actor-node-playwright:20

COPY . .

RUN npm install --prefix /usr/src/app

CMD ["npm", "start"]
