FROM node:18-alpine

# نصب پکیج‌های مورد نیاز سیستم عامل برای ابزارهای بیلد پکیج‌های نود جی اس
RUN apk add --no-cache python3 make g++ gcc

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# ایجاد پوشه موقت آپلودها با دسترسی‌های کامل لینوکس
RUN mkdir -p uploads

EXPOSE 8080

CMD ["npm", "start"]
