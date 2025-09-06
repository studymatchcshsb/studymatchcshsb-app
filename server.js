require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const fs = require('fs');
const Datastore = require('nedb');
const bcrypt = require('bcrypt');
const http = require('http');
const socketIo = require('socket.io');
const saltRounds = 10;

console.log("--- SERVER.JS HAS BEEN UPDATED! ---");
console.log("--- If you see this, the new code is running. ---");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new Datastore({ filename: 'users.db', autoload: true });
const todosDb = new Datastore({ filename: 'todos.db', autoload: true });

let currentCode = "";
let storedEmail = "";

// Enhanced transporter with detailed logging
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  },
  logger: true, // Enable logging
  debug: true   // Include SMTP traffic in the logs
});

// Verify transporter configuration on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("--- EMAIL TRANSPORTER VERIFICATION FAILED ---");
    console.error("Error details:", error);
  } else {
    console.log("--- EMAIL TRANSPORTER VERIFICATION SUCCESSFUL ---");
  }
});

app.post("/send-code", (req, res) => {
  console.log("--- /send-code endpoint was hit! ---");
  const { email } = req.body;
  currentCode = Math.floor(100000 + Math.random() * 900000).toString();
  storedEmail = email;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Your Verification Code",
    text: `Your verification code is: ${currentCode}`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("--- NODEMAILER ERROR ---:", error);
      console.error("--- ERROR DETAILS ---:");
      console.error("Error code:", error.code);
      console.error("Error response:", error.response);
      console.error("Error command:", error.command);
      
      // Check for specific error types
      if (error.code === 'EAUTH') {
        return res.status(500).send("Authentication failed. Please check your email credentials.");
      } else if (error.code === 'EENVELOPE') {
        return res.status(500).send("Invalid email address format.");
      } else if (error.code === 'ETIMEDOUT') {
        return res.status(500).send("Connection timeout. Please try again.");
      }
      
      return res.status(500).send(`NODEMAILER FAILED: ${error.message}`);
    }
    console.log("--- Email Sent Successfully ---:", info);
    res.send("Code sent successfully!");
  });
});

app.post("/verify-code", (req, res) => {
  const { email, code, isLogin } = req.body;

  if (email !== storedEmail || code !== currentCode) {
    return res.send({ success: false, message: "Verification Code entered is wrong. Resend Code?" });
  }

  db.findOne({ email: email }, (err, user) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send({ success: false, message: "Server error." });
    }

    if (isLogin) {
      if (user) {
        res.send({ success: true, isNewUser: false });
      } else {
        res.send({ success: false, message: "No account found with this email. Please sign up." });
      }
    } else { // Sign up
      if (user) {
        res.send({ success: false, message: "An account with this email already exists. Please log in." });
      } else {
        res.send({ success: true, isNewUser: true });
      }
    }
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;

  db.findOne({ email: email }, (err, user) => {
    if (err || !user) {
      return res.status(401).send({ success: false, message: 'Invalid email or password.' });
    }

    bcrypt.compare(password, user.password, (err, result) => {
      if (result) {
        storedEmail = user.email; // Store email on successful login
        res.send({ success: true });
      } else {
        res.status(401).send({ success: false, message: 'Invalid email or password.' });
      }
    });
  });
});

app.post('/check-lrn', (req, res) => {
  const { lrn } = req.body;
  fs.readFile('allowed-lrns.json', 'utf8', (err, data) => {
    if (err) {
      console.error("Error reading LRN file:", err);
      return res.status(500).send({ success: false, message: 'Server error checking LRN.' });
    }
    const allowedLrns = JSON.parse(data).allowed;
    if (allowedLrns.includes(lrn)) {
      res.send({ success: true });
    } else {
      res.status(403).send({ success: false, message: 'This LRN is not authorized to register.' });
    }
  });
});

app.post('/save-profile', (req, res) => {
  // Password should already be hashed from the frontend
  const profileData = {
    name: req.body.name,
    surname: req.body.surname,
    lrn: req.body.lrn,
    grade: req.body.grade,
    section: req.body.section,
    email: storedEmail,
    password: req.body.password, // Already hashed from frontend
    createdAt: new Date()
  };

  db.insert(profileData, (err, newDoc) => {
    if (err) {
      console.error("Error saving profile:", err);
      return res.status(500).send({ success: false, message: 'Server error saving profile.' });
    }
    console.log("Profile saved successfully:", newDoc);
    res.send({ success: true, message: 'Profile saved!' });
  });
});

app.post('/update-profile', (req, res) => {
  const { strengths, weaknesses } = req.body;

  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized. Please log in again.' });
  }

  db.update({ email: storedEmail }, { $set: { strengths: strengths, weaknesses: weaknesses } }, {}, (err, numReplaced) => {
    if (err) {
      console.error("Error updating profile:", err);
      return res.status(500).send({ success: false, message: 'Server error updating profile.' });
    }
    if (numReplaced === 0) {
      return res.status(404).send({ success: false, message: 'User not found.' });
    }
    console.log(`Profile updated for email: ${storedEmail}`);
    res.send({ success: true, message: 'Profile updated successfully!' });
  });
});

// To-Do List Endpoints
app.get('/get-todos', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send([]);
  }
  todosDb.find({ userEmail: storedEmail }, (err, docs) => {
    if (err) {
      return res.status(500).send([]);
    }
    res.send(docs);
  });
});

app.post('/add-todo', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }
  const { title, items } = req.body;
  const newTodo = {
    title,
    items,
    userEmail: storedEmail,
    createdAt: new Date()
  };
  todosDb.insert(newTodo, (err, doc) => {
    if (err) {
      return res.status(500).send({ success: false, message: 'Server error' });
    }
    res.send({ success: true, todo: doc });
  });
});

app.delete('/delete-todo/:id', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }
  todosDb.remove({ _id: req.params.id, userEmail: storedEmail }, {}, (err, numRemoved) => {
    if (err || numRemoved === 0) {
      return res.status(500).send({ success: false, message: 'Could not delete item.' });
    }
    res.send({ success: true });
  });
});

app.get('/get-profile', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }
  db.findOne({ email: storedEmail }, (err, user) => {
    if (err || !user) {
      return res.status(404).send({ success: false, message: 'User not found' });
    }
    res.send({ success: true, user });
  });
});

app.post('/send-help-request', (req, res) => {
  const { message } = req.body;

  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.EMAIL_USER, // Send to admin
    subject: `StudyMatch Help Request from ${storedEmail}`,
    text: `A new help request has been submitted by ${storedEmail}:\n\n${message}`,
    replyTo: storedEmail
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("--- HELP REQUEST EMAIL ERROR ---:", error);
      return res.status(500).send({ success: false, message: 'Failed to send help request.' });
    }
    console.log("--- Help Request Email Sent ---:", info);
    res.send({ success: true });
  });
});

app.post('/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: storedEmail }, (err, user) => {
    if (err || !user) {
      return res.status(401).send({ success: false, message: 'User not found.' });
    }

    bcrypt.compare(currentPassword, user.password, (err, result) => {
      if (result) {
        bcrypt.hash(newPassword, saltRounds, (err, hash) => {
          if (err) {
            return res.status(500).send({ success: false, message: 'Error changing password.' });
          }
          db.update({ email: storedEmail }, { $set: { password: hash } }, {}, (err, numReplaced) => {
            if (err || numReplaced === 0) {
              return res.status(500).send({ success: false, message: 'Error changing password.' });
            }
            res.send({ success: true });
          });
        });
      } else {
        res.status(401).send({ success: false, message: 'Incorrect current password.' });
      }
    });
  });
});

app.post('/logout', (req, res) => {
  storedEmail = "";
  res.send({ success: true });
});

// Test endpoint for email configuration
app.get('/test-email-config', (req, res) => {
  console.log("--- Testing email configuration ---");
  console.log("EMAIL_USER:", process.env.EMAIL_USER);
  console.log("EMAIL_PASS length:", process.env.EMAIL_PASS ? process.env.EMAIL_PASS.length : 0);
  
  // Verify environment variables are loaded
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.status(500).send("Email configuration missing in environment variables");
  }
  
  // Test transporter
  transporter.verify((error, success) => {
    if (error) {
      console.error("--- EMAIL CONFIGURATION TEST FAILED ---");
      console.error("Error details:", error);
      return res.status(500).json({
        success: false,
        message: "Email configuration test failed",
        error: error.message,
        code: error.code
      });
    } else {
      console.log("--- EMAIL CONFIGURATION TEST SUCCESSFUL ---");
      res.json({
        success: true,
        message: "Email configuration is working correctly"
      });
    }
  });
});

const server = http.createServer(app);
const io = socketIo(server);

// Store connected users
const connectedUsers = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (email) => {
    connectedUsers[email] = socket.id;
    socket.email = email;
    console.log(`${email} joined with socket ${socket.id}`);
  });

  socket.on('send message', (data) => {
    const { to, message } = data;
    const from = socket.email;
    const recipientSocket = connectedUsers[to];

    if (recipientSocket) {
      io.to(recipientSocket).emit('receive message', { from, message, timestamp: new Date() });
    }
    // Also emit to sender for consistency
    socket.emit('receive message', { from, message, timestamp: new Date() });
  });

  socket.on('disconnect', () => {
    if (socket.email) {
      delete connectedUsers[socket.email];
      console.log(`${socket.email} disconnected`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`--- Nodemon server running at http://localhost:${PORT} ---`);
});