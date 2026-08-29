# راه‌اندازی Login سامانه بازدید دیلی‌مارکت

## 1) Master Database
فایل `DailyMarket_Field_Visit_Master_v2.xlsx` را در Google Drive آپلود و با Google Sheets باز کنید.

## 2) Apps Script
در همان Google Sheet:

`Extensions > Apps Script`

محتویات پیش‌فرض `Code.gs` را حذف و فایل `Code.gs` این پکیج را Paste کنید.

## 3) راه‌اندازی اولیه
از بالای Apps Script تابع `setupAuth` را انتخاب و فقط یک بار Run کنید.
مجوزهای Google را تأیید کنید.

این کار:
- Spreadsheet ID را در Script Properties ذخیره می‌کند.
- برای تمام کاربران `password_hash` ایجاد می‌کند.
- Sheet مربوط به Session را آماده می‌کند.
- Timezone فایل را روی `Asia/Tehran` قرار می‌دهد.

## 4) Deploy
در Apps Script:

`Deploy > New deployment > Web app`

- Execute as: **Me**
- Who has access: **Anyone**

Deploy را بزنید و URLای که با `/exec` تمام می‌شود کپی کنید.

## 5) اتصال GitHub
فایل `app-config.js` را باز کنید و مقدار زیر را عوض کنید:

```js
APPS_SCRIPT_URL: 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE'
```

به جای Placeholder، URL مرحله قبل را قرار دهید.

## 6) فایل‌های GitHub
این فایل‌ها را در Root Repository قرار دهید:

- `index.html`
- `app-config.js`
- `auth-client.js`
- `executive-dashboard.html`
- `regional-dashboard.html`
- `areahead-dashboard.html`

## 7) اکانت تست
بر اساس Master Database:

- مدیر اجرایی: `10001` / `1101`
- مدیر منطقه: `20001` / `2101`
- رئیس ناحیه: `30001` / `3101`

بعد از ورود هر نقش باید وارد صفحه مربوط به خودش شود.


## وضعیت نسخه v2
آدرس Web App در فایل app-config.js تنظیم شده و نیازی به Paste مجدد URL نیست.
