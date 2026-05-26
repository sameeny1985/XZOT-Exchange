FROM node:18-alpine

# نصب پکیج‌های مورد نیاز برای سیستم عامل مصور در صورت نیاز multer
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# ایجاد پوشه موقت آپلودها
RUN mkdir -p uploads

EXPOSE 8080

CMD ["npm", "start"]
