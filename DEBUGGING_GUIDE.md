# Debugging Guide for StudyMatch Email Sending Issue

## Testing the Button Functionality

1. **Open Browser Developer Tools**:
   - Press F12 or right-click on the page and select "Inspect"
   - Go to the "Console" tab

2. **Refresh the Page**:
   - Press Ctrl+F5 (or Cmd+Shift+R on Mac) to do a hard refresh
   - This ensures the updated JavaScript code is loaded

3. **Test the Button**:
   - Enter an email address in the email field
   - Click the "Sign Up" button (default mode) or "Log In" button (after toggling mode)
   - Watch the console for debugging messages

## Expected Debugging Output

When the button is clicked, you should see messages in this order:

1. "handleAction called"
2. "codeStep: false"
3. "isLoginMode: false" (or true if in login mode)
4. "Calling sendSignupCode" (or "Calling sendLoginCode")
5. "Email value: [your email]"
6. "Sending request to /send-code with email: [your email]"
7. "Received response from server: [Response object]"
8. Either "Code sent successfully" or an error message

## Troubleshooting

### If No Debugging Messages Appear

1. **Check if JavaScript is enabled** in your browser
2. **Verify the onclick handler** is properly attached to the button:
   - Look at the button element in the "Elements" tab of developer tools
   - Check if it has the `onclick="handleAction()"` attribute
3. **Check for JavaScript errors** in the Console tab
4. **Try a hard refresh** (Ctrl+F5) to ensure the latest code is loaded

### If Debugging Messages Appear But No Response from Server

1. **Check if the server is running**:
   - Look at your terminal where you started the server
   - You should see log messages when requests are received

2. **Check for network errors**:
   - Go to the "Network" tab in developer tools
   - Look for the request to `/send-code`
   - Check its status code and response

3. **Check server logs**:
   - Look at your terminal where you started the server
   - You should see messages like:
     - "--- /send-code endpoint was hit! ---"
     - "--- Email Sent Successfully ---" (if successful)
     - "--- NODEMAILER ERROR ---" (if there's an error)

### If You See an Error Message

1. **Authentication failed**:
   - Make sure you're using a Gmail App Password, not your regular password
   - Check that the EMAIL_USER and EMAIL_PASS in your .env file are correct

2. **Invalid email address format**:
   - Make sure you're entering a valid email address

3. **Connection timeout**:
   - Check your internet connection
   - Make sure there's no firewall blocking the connection

## Testing the Server Directly

You can also test if the server is working properly by sending a request directly:

1. Open a terminal
2. Run the following command (replace your-email@example.com with a real email):
   ```
   curl -X POST http://localhost:3000/send-code -H "Content-Type: application/json" -d '{"email":"your-email@example.com"}'
   ```

3. Check the server logs for messages

## Common Issues and Solutions

1. **Gmail App Password**:
   - Make sure you're using an App Password, not your regular Gmail password
   - Generate one at: https://myaccount.google.com/apppasswords

2. **Server not running**:
   - Make sure you've started the server with `npm start` or `node server.js`

3. **Port conflicts**:
   - Make sure no other application is using port 3000
   - You can change the port in server.js if needed

4. **CORS issues**:
   - The server should already have CORS enabled, but if you're accessing it from a different port, there might be issues

5. **Firewall/Network issues**:
   - Make sure your firewall isn't blocking outgoing connections on port 587 (Gmail SMTP)