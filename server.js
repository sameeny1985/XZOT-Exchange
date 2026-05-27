require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8080;

// مطمئن شدن از وجود پوشه آپلودها
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// تنظیمات ذخیره‌سازی فایل‌های آپلودی با پسوند درست
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// راه‌اندازی ربات تلگرام
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// تنظیمات سرویس ایمیل
const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // حتما باید App Password جی‌میل باشد
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// اصلاح نحوه دسترسی به پوشه آپلودها به صورت کاملا استاتیک و عمومی
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const pendingOrders = {};

// ۱. دریافت فرم کامل مشتری و ارسال به تلگرام
app.post('/api/submit-order', upload.fields([
    { name: 'idFront', maxCount: 1 },
    { name: 'idBack', maxCount: 1 },
    { name: 'receipt', maxCount: 1 }
]), async (req, res) => {
    try {
        const { email, crypto, network, wallet, paymentMethod, amount, paysafePin } = req.body;
        const files = req.files;

        if (!email || !crypto || !network || !wallet || !paymentMethod || !amount) {
            return res.status(400).json({ success: false, message: 'Missing required fields.' });
        }

        const orderId = 'ORD-' + Date.now();
        
        // اصلاح مسیر ذخیره فایل برای وبک (حذف دات و اسلش‌های اضافی)
        const idFrontPath = files['idFront'] ? files['idFront'][0].path.replace(/\\/g, '/') : null;
        const idBackPath = files['idBack'] ? files['idBack'][0].path.replace(/\\/g, '/') : null;
        const receiptPath = files['receipt'] ? files['receipt'][0].path.replace(/\\/g, '/') : null;

        pendingOrders[orderId] = {
            email, crypto, network, wallet, paymentMethod, amount, paysafePin,
            idFront: idFrontPath,
            idBack: idBackPath,
            receipt: receiptPath,
            status: 'PENDING'
        };

        // تمیز کردن آدرس سرور برای جلوگیری از ارور دو اسلش //
        let serverUrl = process.env.SERVER_URL || `http://localhost:${port}`;
        if (serverUrl.endsWith('/')) {
            serverUrl = serverUrl.slice(0, -1);
        }
        
        let paymentDetail = '';
        if (paymentMethod === 'paysafe') {
            paymentDetail = `🔑 *Paysafe PIN:* \`${paysafePin}\``;
        } else if (receiptPath) {
            paymentDetail = `🧾 *SEPA Receipt:* [View Receipt](${serverUrl}/${receiptPath})`;
        }

        const messageText = `🔔 *New Exchange Order: ${orderId}*\n\n` +
                            `📧 *User Email:* \`${email}\`\n` +
                            `💰 *Amount:* ${amount} EUR\n` +
                            `🪙 *Asset:* ${crypto} (${network})\n` +
                            `👛 *Destination Wallet:* \`${wallet}\`\n` +
                            `💳 *Method:* ${paymentMethod.toUpperCase()}\n` +
                            `${paymentDetail}\n\n` +
                            `🪪 *KYC Documents:* \n` +
                            `[ID Front Side](${serverUrl}/${idFrontPath})\n` +
                            `[ID Back Side](${serverUrl}/${idBackPath})\n\n` +
                            `👇 Action Required:`;

        // ذخیره متن اصلی پیام در حافظه برای جلوگیری از پاک شدن گزارش در تلگرام
        pendingOrders[orderId].originalMessage = messageText;

        await bot.telegram.sendMessage(process.env.TELEGRAM_CHANNEL_ID, messageText, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('🟢 Approve & Send Crypto', `approve_${orderId}`),
                    Markup.button.callback('🔴 Reject Order', `reject_${orderId}`)
                ]
            ])
        });

        res.json({ success: true, message: 'Order submitted successfully.' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ۲. پردازش دکمه‌های شیشه‌ای تلگرام (تایید / رد) بدون پاک شدن اطلاعات قبلی
bot.on('callback_query', async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const [action, orderId] = callbackData.split('_');
    const order = pendingOrders[orderId];

    if (!order) {
        return ctx.answerCbQuery('❌ Order not found or expired.', { show_alert: true });
    }

    if (order.status !== 'PENDING') {
        return ctx.answerCbQuery('⚠️ This order has already been processed.', { show_alert: true });
    }

    const baseText = order.originalMessage || `🔔 *Exchange Order: ${orderId}*`;

    if (action === 'reject') {
        order.status = 'REJECTED';
        // ویرایش پیام به طوری که متن اصلی باقی بماند و فقط وضعیت در انتها اضافه شود
        await ctx.editMessageText(`${baseText}\n\n❌ *Status: REJECTED by Admin.*`, { parse_mode: 'Markdown' });
        return ctx.answerCbQuery('Order Rejected.');
    }

    if (action === 'approve') {
        ctx.answerCbQuery('⏳ Verification approved. Dispatching email...');
        await ctx.editMessageText(`${baseText}\n\n⏳ *Status: Processing transfer & sending email...*`, { parse_mode: 'Markdown' });

        try {
            // ساختار ایمیل ارسالی به مشتری
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: order.email,
                subject: 'Your Crypto Exchange Order has been Completed! ✅',
                html: `
                    <div style="direction: ltr; font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ffdd00; border-radius: 8px; background-color: #1a1a24; color: #ffffff;">
                        <h2 style="color: #ffdd00; text-align: center;">Transaction Successful</h2>
                        <p>Dear Customer,</p>
                        <p>We are pleased to inform you that your exchange order <strong>${orderId}</strong> has been successfully verified and processed.</p>
                        <hr style="border-color: #ffdd00;">
                        <p><strong>Paid Amount:</strong> ${order.amount} EUR</p>
                        <p><strong>Received Crypto:</strong> ${order.crypto}</p>
                        <p><strong>Network:</strong> ${order.network}</p>
                        <p><strong>Destination Wallet:</strong> <span style="color: #ffdd00;">${order.wallet}</span></p>
                        <hr style="border-color: #ffdd00;">
                        <p style="text-align: center; font-size: 12px; color: #9ca3af;">Thank you for choosing XZOT Exchange.</p>
                    </div>
                `
            };

            // ارسال ایمیل
            await transporter.sendMail(mailOptions);
            order.status = 'COMPLETED';

            // آپدیت نهایی پیام تلگرام بدون پاک شدن جزییات
            await ctx.editMessageText(`${baseText}\n\n✅ *Status: COMPLETED.*\n💰 Crypto assets delivered and email notification sent to user.`, { parse_mode: 'Markdown' });

        } catch (mailError) {
            console.error('Email Delivery Error:', mailError);
            // نمایش خطای دقیق ایمیل در تلگرام برای دیباگ شما
            await ctx.editMessageText(`${baseText}\n\n⚠️ *Status: Verification approved, but Email failed:* \n\`${mailError.message}\``, { parse_mode: 'Markdown' });
        }
    }
});

bot.launch();
app.listen(port, () => console.log(`Server is running on port ${port}`));
