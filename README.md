# StudyMatch Email Configuration

## Gmail Setup Instructions

To get the email verification system working properly, you need to configure Gmail with an App Password:

1. Go to your Google Account settings: https://myaccount.google.com/
2. Navigate to Security settings
3. Enable 2-Step Verification if not already enabled
4. Generate an App Password:
   - In the Security section, select "App passwords"
   - Select "Mail" and your device
   - Copy the generated password
5. Update your `.env` file with the App Password:
   ```
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=your-generated-app-password
   ```

## Troubleshooting

If emails are still not sending, check:

1. That you're using an App Password, not your regular Gmail password
2. That 2-Step Verification is enabled on your Google account
3. That the Gmail account allows access from less secure apps (if using older accounts)
4. That your firewall isn't blocking outgoing connections on port 587

## Testing

After configuration, restart your server and try sending a verification code through the login/signup process.