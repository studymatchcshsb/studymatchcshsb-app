require('dotenv').config();
const express = require("express");
const nodemailer = require("nodemailer");
const sgMail = require('@sendgrid/mail');
const cors = require("cors");
const fs = require('fs');
const Datastore = require('nedb');
const bcrypt = require('bcryptjs');
const http = require('http');
const socketIo = require('socket.io');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const saltRounds = 10;

console.log("--- SERVER.JS HAS BEEN UPDATED! ---");
console.log("--- If you see this, the new code is running. ---");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.static("public"));

const db = new Datastore({ filename: 'users.db', autoload: true });
const todosDb = new Datastore({ filename: 'todos.db', autoload: true });
const sessionsDb = new Datastore({ filename: 'sessions.db', autoload: true });
const messagesDb = new Datastore({ filename: 'messages.db', autoload: true });

let currentCode = "";
let storedEmail = "";

// Session management functions
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getUserFromSession(req) {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) return null;

  return new Promise((resolve, reject) => {
    sessionsDb.findOne({ sessionId }, (err, session) => {
      if (err) {
        console.error('Session lookup error:', err);
        return resolve(null);
      }

      if (!session || session.expires < Date.now()) {
        if (session && session.expires < Date.now()) {
          // Clean up expired session
          sessionsDb.remove({ sessionId }, {}, () => {});
        }
        return resolve(null);
      }

      resolve(session.email);
    });
  });
}

function createSession(email, res) {
  const sessionId = generateSessionId();
  const expires = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 days

  const session = {
    sessionId,
    email,
    expires,
    createdAt: new Date()
  };

  return new Promise((resolve, reject) => {
    sessionsDb.insert(session, (err) => {
      if (err) {
        console.error('Session creation error:', err);
        return reject(err);
      }

      // Set HTTP-only cookie
      res.cookie('sessionId', sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      resolve();
    });
  });
}

function destroySession(req, res) {
  const sessionId = req.cookies.sessionId;
  if (sessionId) {
    sessionsDb.remove({ sessionId }, {}, (err) => {
      if (err) console.error('Session removal error:', err);
    });
  }

  res.clearCookie('sessionId');
}

// Middleware to check authentication
async function requireAuth(req, res, next) {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  req.userEmail = userEmail;
  storedEmail = userEmail; // For backward compatibility
  next();
}

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("--- SENDGRID INITIALIZED SUCCESSFULLY ---");
} else {
  console.log("--- SENDGRID API KEY NOT FOUND - USING GMAIL FALLBACK ---");
}

// Fallback Gmail transporter (for backward compatibility)
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  },
  logger: true,
  debug: true
});

app.post("/send-code", async (req, res) => {
  console.log("--- /send-code endpoint was hit! ---");
  const { email } = req.body;

  // Generate a random 6-digit code
  currentCode = Math.floor(100000 + Math.random() * 900000).toString();
  storedEmail = email;

  console.log(`Generated code ${currentCode} for ${email}`);

  // Try SendGrid first (preferred for production)
  if (process.env.SENDGRID_API_KEY) {
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);

      const msg = {
        to: email,
        from: {
          email: 'studymatchcshsb@gmail.com', // Your verified SendGrid sender email
          name: 'StudyMatch'
        },
        subject: 'Your StudyMatch Verification Code',
        text: `Your verification code is: ${currentCode}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this email.`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #3498db;">StudyMatch Verification</h2>
            <p>Hello!</p>
            <p>Your verification code is:</p>
            <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
              <span style="font-size: 24px; font-weight: bold; color: #e74c3c;">${currentCode}</span>
            </div>
            <p>This code will expire in 10 minutes.</p>
            <p>If you didn't request this code, please ignore this email.</p>
            <hr style="margin: 30px 0;">
            <p style="color: #7f8c8d; font-size: 12px;">StudyMatch - Real-time Study Buddy Matching</p>
          </div>
        `,
      };

      await sgMail.send(msg);
      console.log("--- VERIFICATION EMAIL SENT VIA SENDGRID ---");
      console.log("Email sent to:", email);
      console.log("Code:", currentCode);
      return res.send("Verification code sent to your email!");
    } catch (error) {
      console.error("--- SENDGRID EMAIL ERROR ---");
      console.error("Error:", error.message);
      console.error("Code:", error.code);
      console.error("Response body:", error.response?.body);
      // Fall back to Gmail if SendGrid fails
    }
  }

  // Fallback to Gmail
  console.log("--- FALLING BACK TO GMAIL ---");
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: "Your StudyMatch Verification Code",
    text: `Your verification code is: ${currentCode}\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #3498db;">StudyMatch Verification</h2>
        <p>Hello!</p>
        <p>Your verification code is:</p>
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; margin: 20px 0;">
          <span style="font-size: 24px; font-weight: bold; color: #e74c3c;">${currentCode}</span>
        </div>
        <p>This code will expire in 10 minutes.</p>
        <p>If you didn't request this code, please ignore this email.</p>
        <hr style="margin: 30px 0;">
        <p style="color: #7f8c8d; font-size: 12px;">StudyMatch - Real-time Study Buddy Matching</p>
      </div>
    `,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("--- GMAIL EMAIL SEND ERROR ---");
      console.error("Error code:", error.code);
      console.error("Error response:", error.response);
      console.error("Error message:", error.message);

      // Provide more specific error messages
      if (error.code === 'EAUTH') {
        return res.status(500).send("Email authentication failed. Please check Gmail app password.");
      } else if (error.code === 'ENOTFOUND') {
        return res.status(500).send("Email server not found. Please try again later.");
      } else if (error.code === 'ETIMEDOUT') {
        return res.status(500).send("Email server timeout. Please try again later.");
      } else {
        return res.status(500).send(`Email error: ${error.message}`);
      }
    }

    console.log("--- VERIFICATION EMAIL SENT VIA GMAIL ---");
    console.log("Email sent to:", email);
    console.log("Code:", currentCode);
    console.log("Message ID:", info.messageId);
    res.send("Verification code sent to your email!");
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

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  db.findOne({ email: email }, async (err, user) => {
    if (err || !user) {
      return res.status(401).send({ success: false, message: 'Invalid email or password.' });
    }

    bcrypt.compare(password, user.password, async (err, result) => {
      if (result) {
        try {
          await createSession(user.email, res);
          storedEmail = user.email; // Store email on successful login
          res.send({ success: true });
        } catch (error) {
          console.error('Session creation error:', error);
          res.status(500).send({ success: false, message: 'Login failed. Please try again.' });
        }
      } else {
        res.status(401).send({ success: false, message: 'Invalid email or password.' });
      }
    });
  });
});

app.post('/check-lrn', (req, res) => {
  const { lrn, firstName, surname } = req.body;

  if (!firstName || !surname) {
    return res.status(400).send({ success: false, message: 'First name and surname are required for LRN validation.' });
  }

  fs.readFile('allowed-lrns.json', 'utf8', (err, data) => {
    if (err) {
      console.error("Error reading LRN file:", err);
      return res.status(500).send({ success: false, message: 'Server error checking LRN.' });
    }

    const lrnData = JSON.parse(data);
    const student = lrnData.students.find(s => s.lrn === lrn);

    if (!student) {
      return res.status(403).send({ success: false, message: 'This LRN is not authorized to register.' });
    }

    // Check if LRN is already used
    if (student.used) {
      return res.status(403).send({ success: false, message: 'This LRN has already been registered. Each LRN can only be used once.' });
    }

    // Check if name matches (case-insensitive)
    const nameMatches = student.firstName.toLowerCase() === firstName.toLowerCase().trim() &&
                       student.surname.toLowerCase() === surname.toLowerCase().trim();

    if (!nameMatches) {
      return res.status(403).send({
        success: false,
        message: `LRN ${lrn} is only valid for ${student.firstName} ${student.surname}. Please check your name and try again.`
      });
    }

    res.send({ success: true });
  });
});

app.post('/save-profile', (req, res) => {
  // Hash the password on the server for security
  bcrypt.hash(req.body.password, saltRounds, (err, hash) => {
    if (err) {
      console.error("Error hashing password:", err);
      return res.status(500).send({ success: false, message: 'Server error hashing password.' });
    }

    const profileData = {
      name: req.body.name,
      surname: req.body.surname,
      lrn: req.body.lrn,
      grade: req.body.grade,
      section: req.body.section,
      email: storedEmail,
      password: hash, // Now properly hashed
      createdAt: new Date()
    };

    // First, mark the LRN as used
    fs.readFile('allowed-lrns.json', 'utf8', (err, data) => {
      if (err) {
        console.error("Error reading LRN file:", err);
        return res.status(500).send({ success: false, message: 'Server error saving profile.' });
      }

      const lrnData = JSON.parse(data);
      const studentIndex = lrnData.students.findIndex(s => s.lrn === req.body.lrn);

      if (studentIndex === -1) {
        return res.status(400).send({ success: false, message: 'Invalid LRN.' });
      }

      // Mark LRN as used
      lrnData.students[studentIndex].used = true;

      // Write back to file
      fs.writeFile('allowed-lrns.json', JSON.stringify(lrnData, null, 2), 'utf8', (err) => {
        if (err) {
          console.error("Error updating LRN file:", err);
          return res.status(500).send({ success: false, message: 'Server error saving profile.' });
        }

        // Now save the profile to database
        db.insert(profileData, (err, newDoc) => {
          if (err) {
            console.error("Error saving profile:", err);
            // If database save fails, we should revert the LRN status
            lrnData.students[studentIndex].used = false;
            fs.writeFileSync('allowed-lrns.json', JSON.stringify(lrnData, null, 2), 'utf8');
            return res.status(500).send({ success: false, message: 'Server error saving profile.' });
          }

          console.log("Profile saved successfully:", newDoc);

          // Create session for the new user
          createSession(storedEmail, res).then(() => {
            console.log("Session created for new user:", storedEmail);
            res.send({ success: true, message: 'Profile saved successfully!' });
          }).catch((sessionError) => {
            console.error("Session creation failed:", sessionError);
            // Still send success since profile was saved
            res.send({ success: true, message: 'Profile saved successfully!' });
          });
        });
      });
    });
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
  destroySession(req, res);
  storedEmail = "";
  res.send({ success: true });
});

// Check if user is logged in
app.get('/check-session', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (userEmail) {
    storedEmail = userEmail; // For backward compatibility
    res.send({ loggedIn: true, email: userEmail });
  } else {
    res.send({ loggedIn: false });
  }
});

// Search users endpoint
app.get('/search-users', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const query = req.query.q;
  if (!query || query.length < 2) {
    return res.send({ users: [] });
  }

  // Search for users by name or email (excluding current user)
  db.find({
    $or: [
      { name: new RegExp(query, 'i') },
      { surname: new RegExp(query, 'i') },
      { email: new RegExp(query, 'i') }
    ],
    email: { $ne: storedEmail } // Exclude current user
  }, (err, users) => {
    if (err) {
      console.error("Error searching users:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    // Return only necessary user info
    const userResults = users.map(user => ({
      name: user.name,
      surname: user.surname,
      email: user.email,
      grade: user.grade,
      section: user.section
    }));

    res.send({ users: userResults });
  });
});

// Send friend request endpoint
app.post('/add-friend', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { friendEmail } = req.body;

  if (!friendEmail) {
    return res.status(400).send({ success: false, message: 'Friend email is required' });
  }

  if (friendEmail === storedEmail) {
    return res.status(400).send({ success: false, message: 'Cannot add yourself as a friend' });
  }

  // Check if friend exists
  db.findOne({ email: friendEmail }, (err, friend) => {
    if (err) {
      console.error("Error finding friend:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!friend) {
      return res.status(404).send({ success: false, message: 'User not found' });
    }

    // Get current user info
    db.findOne({ email: storedEmail }, (err, currentUser) => {
      if (err) {
        console.error("Error finding current user:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      if (!currentUser) {
        return res.status(404).send({ success: false, message: 'Current user not found' });
      }

      // Check if already friends
      if (currentUser.friends && currentUser.friends.includes(friendEmail)) {
        return res.status(400).send({ success: false, message: 'Already friends with this user' });
      }

      // Check if friend request already sent
      if (friend.notifications && friend.notifications.some(n =>
        n.type === 'friend_request' && n.fromUser.email === storedEmail && n.status === 'pending'
      )) {
        return res.status(400).send({ success: false, message: 'Friend request already sent' });
      }

      // Create friend request notification
      const friendRequest = {
        id: Date.now() + Math.random(),
        type: 'friend_request',
        fromUser: {
          name: currentUser.name,
          surname: currentUser.surname,
          email: storedEmail,
          grade: currentUser.grade
        },
        timestamp: new Date(),
        status: 'pending'
      };

      // Add notification to friend's profile
      db.update(
        { email: friendEmail },
        { $push: { notifications: friendRequest } },
        { upsert: true },
        (err, numReplaced) => {
          if (err) {
            console.error("Error sending friend request:", err);
            return res.status(500).send({ success: false, message: 'Server error' });
          }

          // Notify the friend in real-time if they're online
          if (connectedUsers[friendEmail]) {
            io.to(connectedUsers[friendEmail]).emit('new_notification', friendRequest);
          }

          console.log(`Friend request sent: ${storedEmail} -> ${friendEmail}`);
          res.send({ success: true, message: 'Friend request sent successfully!' });
        }
      );
    });
  });
});

// Get friends list endpoint
app.get('/get-friends', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: storedEmail }, (err, user) => {
    if (err) {
      console.error("Error finding user:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!user || !user.friends) {
      return res.send({ friends: [] });
    }

    // Get friend details
    db.find({ email: { $in: user.friends } }, (err, friends) => {
      if (err) {
        console.error("Error finding friends:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      const friendDetails = friends.map(friend => ({
        name: friend.name,
        surname: friend.surname,
        email: friend.email,
        grade: friend.grade,
        section: friend.section
      }));

      res.send({ friends: friendDetails });
    });
  });
});

// Get messages between two users
app.get('/get-messages/:friendEmail', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const friendEmail = req.params.friendEmail;

  // Find messages between current user and friend
  messagesDb.find({
    $or: [
      { from: storedEmail, to: friendEmail },
      { from: friendEmail, to: storedEmail }
    ]
  }).sort({ timestamp: 1 }, (err, messages) => {
    if (err) {
      console.error("Error finding messages:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    res.send({ messages });
  });
});

// Send help request endpoint
app.post('/send-help-request', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { grade, subject } = req.body;

  if (!grade || !subject) {
    return res.status(400).send({ success: false, message: 'Grade and subject are required' });
  }

  // Get current user info
  db.findOne({ email: storedEmail }, (err, currentUser) => {
    if (err) {
      console.error("Error finding current user:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!currentUser) {
      return res.status(404).send({ success: false, message: 'User not found' });
    }

    // Find all users in the same grade (excluding current user)
    db.find({ grade: grade, email: { $ne: storedEmail } }, (err, potentialHelpers) => {
      if (err) {
        console.error("Error finding potential helpers:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      if (potentialHelpers.length === 0) {
        return res.send({ success: true, message: 'No users found in your grade level.' });
      }

      // Create help request notifications for each potential helper
      const notifications = potentialHelpers.map(helper => ({
        id: Date.now() + Math.random(),
        type: 'help_request',
        fromUser: {
          name: currentUser.name,
          surname: currentUser.surname,
          email: storedEmail,
          grade: currentUser.grade
        },
        subject: subject,
        timestamp: new Date(),
        status: 'pending'
      }));

      // Add notifications to each helper's profile
      let completed = 0;
      const total = potentialHelpers.length;

      potentialHelpers.forEach(helper => {
        db.update(
          { email: helper.email },
          { $push: { notifications: notifications.find(n => n.fromUser.email === storedEmail) } },
          { upsert: true },
          (err, numReplaced) => {
            if (err) {
              console.error("Error adding notification:", err);
            }
            completed++;
            if (completed === total) {
              // Notify all connected users about new notifications
              notifications.forEach(notification => {
                io.to(connectedUsers[helper.email]).emit('new_notification', notification);
              });

              res.send({
                success: true,
                message: `Help request sent to ${total} students in grade ${grade}!`
              });
            }
          }
        );
      });
    });
  });
});

// Get notifications endpoint
app.get('/get-notifications', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: storedEmail }, (err, user) => {
    if (err) {
      console.error("Error finding user:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!user || !user.notifications) {
      return res.send({ notifications: [] });
    }

    res.send({ notifications: user.notifications });
  });
});

// Handle help request response
app.post('/respond-help-request', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { notificationId, response, requesterEmail } = req.body;

  if (!notificationId || !response) {
    return res.status(400).send({ success: false, message: 'Notification ID and response are required' });
  }

  // Remove the notification from current user's notifications
  db.update(
    { email: storedEmail },
    { $pull: { notifications: { id: notificationId } } },
    {},
    (err, numReplaced) => {
      if (err) {
        console.error("Error removing notification:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      if (response === 'accept' && requesterEmail) {
        // Add both users as friends if they accept
        db.update(
          { email: storedEmail },
          { $addToSet: { friends: requesterEmail } },
          {},
          (err1) => {
            if (err1) console.error("Error adding friend:", err1);

            db.update(
              { email: requesterEmail },
              { $addToSet: { friends: storedEmail } },
              {},
              (err2) => {
                if (err2) console.error("Error adding friend:", err2);

                // Notify the requester that someone accepted
                if (connectedUsers[requesterEmail]) {
                  io.to(connectedUsers[requesterEmail]).emit('help_request_accepted', {
                    helperEmail: storedEmail,
                    subject: req.body.subject
                  });
                }

                res.send({ success: true, message: 'Help request accepted! Starting chat...' });
              }
            );
          }
        );
      } else {
        res.send({ success: true, message: 'Help request declined.' });
      }
    }
  );
});

// Handle friend request response
app.post('/respond-friend-request', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { notificationId, response, requesterEmail } = req.body;

  if (!notificationId || !response) {
    return res.status(400).send({ success: false, message: 'Notification ID and response are required' });
  }

  // Remove the notification from current user's notifications
  db.update(
    { email: storedEmail },
    { $pull: { notifications: { id: notificationId } } },
    {},
    (err, numReplaced) => {
      if (err) {
        console.error("Error removing notification:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      if (response === 'accept' && requesterEmail) {
        // Add both users as friends if they accept
        db.update(
          { email: storedEmail },
          { $addToSet: { friends: requesterEmail } },
          {},
          (err1) => {
            if (err1) console.error("Error adding friend:", err1);

            db.update(
              { email: requesterEmail },
              { $addToSet: { friends: storedEmail } },
              {},
              (err2) => {
                if (err2) console.error("Error adding friend:", err2);

                // Notify the requester that their friend request was accepted
                if (connectedUsers[requesterEmail]) {
                  io.to(connectedUsers[requesterEmail]).emit('friend_request_accepted', {
                    accepterEmail: storedEmail,
                    accepterName: req.body.accepterName
                  });
                }

                res.send({ success: true, message: 'Friend request accepted! You can now chat with each other.' });
              }
            );
          }
        );
      } else {
        // Just remove the notification for deny
        res.send({ success: true, message: 'Friend request declined.' });
      }
    }
  );
});

// Quiz endpoints
app.post('/save-quiz', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { folderName, quizName, flashcards } = req.body;

  if (!folderName || !quizName || !flashcards || flashcards.length === 0) {
    return res.status(400).send({ success: false, message: 'Missing required quiz data' });
  }

  const quizData = {
    folderName,
    quizName,
    flashcards,
    createdAt: new Date()
  };

  // Find user and add quiz to their quizzes array
  db.update(
    { email: storedEmail },
    { $push: { quizzes: quizData } },
    { upsert: true },
    (err, numReplaced) => {
      if (err) {
        console.error("Error saving quiz:", err);
        return res.status(500).send({ success: false, message: 'Server error saving quiz' });
      }

      console.log(`Quiz "${quizName}" saved for user ${storedEmail}`);
      res.send({ success: true, message: 'Quiz saved successfully' });
    }
  );
});

app.get('/get-quizzes', (req, res) => {
  if (!storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: storedEmail }, (err, user) => {
    if (err) {
      console.error("Error finding user:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!user || !user.quizzes) {
      return res.send({ quizzes: [] });
    }

    res.send({ quizzes: user.quizzes });
  });
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
    const timestamp = new Date();

    // Store message in database
    const messageData = {
      from,
      to,
      message,
      timestamp,
      conversationId: [from, to].sort().join('_') // Unique ID for conversation
    };

    messagesDb.insert(messageData, (err, newDoc) => {
      if (err) {
        console.error("Error saving message:", err);
        return;
      }

      // Get sender's name and surname for display
      db.findOne({ email: from }, (err, sender) => {
        if (err) {
          console.error("Error finding sender:", err);
          return;
        }

        const senderName = sender ? `${sender.name} ${sender.surname}` : from;

        // Emit to recipient if online
        const recipientSocket = connectedUsers[to];
        if (recipientSocket) {
          io.to(recipientSocket).emit('receive message', {
            from: senderName,
            fromEmail: from,
            message,
            timestamp
          });
        }

        // Emit to sender for consistency
        socket.emit('receive message', {
          from: senderName,
          fromEmail: from,
          message,
          timestamp
        });
      });
    });
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