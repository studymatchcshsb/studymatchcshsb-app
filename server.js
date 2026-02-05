require('dotenv').config();
const express = require("express");
const cors = require("cors");
const fs = require('fs');
const Datastore = require('nedb');
const bcrypt = require('bcryptjs');
const http = require('http');
const socketIo = require('socket.io');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const saltRounds = 10;

console.log("--- SERVER.JS UPDATED - NOTIFICATION-BASED VERIFICATION ENABLED ---");

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

let storedEmail = "";
let currentCode = "";
let codeEmail = "";

// Session management functions
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getUserFromSession(req) {
  const sessionId = req.cookies.sessionId;
  console.log('Checking session, sessionId:', sessionId ? 'exists' : 'missing');
  console.log('All cookies:', req.cookies);
  
  if (!sessionId) return null;

  return new Promise((resolve, reject) => {
    sessionsDb.findOne({ sessionId }, (err, session) => {
      if (err) {
        console.error('Session lookup error:', err);
        return resolve(null);
      }

      if (!session || session.expires < Date.now()) {
        if (session && session.expires < Date.now()) {
          console.log('Session expired for:', session.email);
          // Clean up expired session
          sessionsDb.remove({ sessionId }, {}, () => {});
        }
        return resolve(null);
      }

      console.log('Session found for:', session.email);
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
        secure: true, // Always use secure cookies (Render uses HTTPS)
        sameSite: 'lax', // 'lax' is more compatible than 'none'
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: '/' // Ensure cookie is available for all paths
      });

      console.log('Session created for:', email, 'with sessionId:', sessionId);
      console.log('Cookie settings: httpOnly=true, secure=true, sameSite=lax, maxAge=30days');
      
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

// Send verification code - displays in notification instead of email
app.post('/send-code', (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).send({ success: false, message: 'Email is required.' });
  }

  // Generate a random 6-digit code
  currentCode = Math.floor(100000 + Math.random() * 900000).toString();
  codeEmail = email;

  console.log(`Generated verification code ${currentCode} for ${email}`);

  // Return the code to be displayed in a notification
  res.send({ 
    success: true, 
    code: currentCode,
    message: 'Verification code generated successfully.'
  });
});

// Verify code endpoint
app.post('/verify-code', (req, res) => {
  const { email, code, isLogin } = req.body;

  if (!email || !code) {
    return res.status(400).send({ success: false, message: 'Email and code are required.' });
  }

  // Check if code matches
  if (email !== codeEmail || code !== currentCode) {
    return res.send({ success: false, message: "Verification code is incorrect. Please try again." });
  }

  // Check if user exists in database
  db.findOne({ email: email }, (err, user) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send({ success: false, message: "Server error." });
    }

    if (isLogin) {
      // For login, user must exist
      if (user) {
        storedEmail = email;
        res.send({ success: true, isNewUser: false });
      } else {
        res.send({ success: false, message: "No account found with this email. Please sign up." });
      }
    } else {
      // For signup, user must not exist
      if (user) {
        res.send({ success: false, message: "An account with this email already exists. Please log in." });
      } else {
        storedEmail = email;
        res.send({ success: true, isNewUser: true });
      }
    }
  });
});

// Registration endpoint - saves user directly to database
app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).send({ success: false, message: 'All fields are required.' });
  }

  // Check if user already exists
  db.findOne({ email: email }, async (err, existingUser) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send({ success: false, message: "Server error." });
    }

    if (existingUser) {
      return res.status(400).send({ success: false, message: "An account with this email already exists. Please log in." });
    }

    // Hash the password
    bcrypt.hash(password, saltRounds, async (err, hash) => {
      if (err) {
        console.error("Error hashing password:", err);
        return res.status(500).send({ success: false, message: 'Server error during registration.' });
      }

      // Create initial user record
      const userData = {
        name: name,
        email: email,
        password: hash,
        createdAt: new Date(),
        profileComplete: false // Flag to indicate profile setup is needed
      };

      db.insert(userData, async (err, newDoc) => {
        if (err) {
          console.error("Error saving user:", err);
          return res.status(500).send({ success: false, message: 'Server error saving user.' });
        }

        console.log("User registered successfully:", email);

        // Create session for the new user
        try {
          await createSession(email, res);
          storedEmail = email;
          res.send({ success: true, message: 'Registration successful!' });
        } catch (sessionError) {
          console.error("Session creation failed:", sessionError);
          res.send({ success: true, message: 'Registration successful! Please log in.' });
        }
      });
    });
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

app.post('/save-profile', async (req, res) => {
  // Check session first
  const userEmail = await getUserFromSession(req);
  if (!userEmail && !storedEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized. Please log in again.' });
  }

  const email = userEmail || storedEmail;

  const profileData = {
    name: req.body.name,
    surname: req.body.surname,
    username: req.body.username,
    lrn: req.body.lrn,
    grade: req.body.grade,
    section: req.body.section,
    profileComplete: true
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

      // Now update the user profile in database
      db.update({ email: email }, { $set: profileData }, {}, (err, numReplaced) => {
        if (err) {
          console.error("Error updating profile:", err);
          // If database update fails, revert the LRN status
          lrnData.students[studentIndex].used = false;
          fs.writeFileSync('allowed-lrns.json', JSON.stringify(lrnData, null, 2), 'utf8');
          return res.status(500).send({ success: false, message: 'Server error saving profile.' });
        }

        if (numReplaced === 0) {
          return res.status(404).send({ success: false, message: 'User not found.' });
        }

        console.log("Profile saved successfully for:", email);
        storedEmail = email; // Update storedEmail for backward compatibility
        res.send({ success: true, message: 'Profile saved successfully!' });
      });
    });
  });
});

app.post('/update-profile', async (req, res) => {
  const { strengths, weaknesses } = req.body;
  const userEmail = await getUserFromSession(req);

  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized. Please log in again.' });
  }

  db.update({ email: userEmail }, { $set: { strengths: strengths, weaknesses: weaknesses } }, {}, (err, numReplaced) => {
    if (err) {
      console.error("Error updating profile:", err);
      return res.status(500).send({ success: false, message: 'Server error updating profile.' });
    }
    if (numReplaced === 0) {
      return res.status(404).send({ success: false, message: 'User not found.' });
    }
    console.log(`Profile updated for email: ${userEmail}`);
    res.send({ success: true, message: 'Profile updated successfully!' });
  });
});

// To-Do List Endpoints
app.get('/get-todos', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send([]);
  }
  todosDb.find({ userEmail: userEmail }, (err, docs) => {
    if (err) {
      return res.status(500).send([]);
    }
    res.send(docs);
  });
});

app.post('/add-todo', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }
  const { title, items } = req.body;
  const newTodo = {
    title,
    items,
    userEmail: userEmail,
    createdAt: new Date()
  };
  todosDb.insert(newTodo, (err, doc) => {
    if (err) {
      return res.status(500).send({ success: false, message: 'Server error' });
    }
    res.send({ success: true, todo: doc });
  });
});

app.delete('/delete-todo/:id', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }
  todosDb.remove({ _id: req.params.id, userEmail: userEmail }, {}, (err, numRemoved) => {
    if (err || numRemoved === 0) {
      return res.status(500).send({ success: false, message: 'Could not delete item.' });
    }
    res.send({ success: true });
  });
});

app.get('/get-profile', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }
  db.findOne({ email: userEmail }, (err, user) => {
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

app.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userEmail = await getUserFromSession(req);

  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: userEmail }, (err, user) => {
    if (err || !user) {
      return res.status(401).send({ success: false, message: 'User not found.' });
    }

    bcrypt.compare(currentPassword, user.password, (err, result) => {
      if (result) {
        bcrypt.hash(newPassword, saltRounds, (err, hash) => {
          if (err) {
            return res.status(500).send({ success: false, message: 'Error changing password.' });
          }
          db.update({ email: userEmail }, { $set: { password: hash } }, {}, (err, numReplaced) => {
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
    
    // Get user profile to check completion status
    db.findOne({ email: userEmail }, (err, user) => {
      if (err || !user) {
        return res.send({ loggedIn: true, email: userEmail, profileComplete: false });
      }
      
      res.send({
        loggedIn: true,
        email: userEmail,
        profileComplete: user.profileComplete || false
      });
    });
  } else {
    res.send({ loggedIn: false });
  }
});



// Get conversations list endpoint with recent messages
app.get('/get-conversations', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Find distinct emails that the user has messages with
  messagesDb.find({
    $or: [
      { from: userEmail },
      { to: userEmail }
    ]
  }, (err, messages) => {
    if (err) {
      console.error("Error finding messages:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    // Get unique conversation partners
    const conversationEmails = [...new Set(
      messages.flatMap(msg => [msg.from, msg.to]).filter(email => email !== userEmail)
    )];

    if (conversationEmails.length === 0) {
      return res.send({ conversations: [] });
    }

    // Get user details for conversation partners
    db.find({ email: { $in: conversationEmails } }, (err, users) => {
      if (err) {
        console.error("Error finding users:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      // Get recent message for each conversation
      let processedConversations = 0;
      const conversationDetails = [];

      users.forEach(user => {
        // Find the most recent message between current user and this user
        messagesDb.find({
          $or: [
            { from: userEmail, to: user.email },
            { from: user.email, to: userEmail }
          ]
        }).sort({ timestamp: -1 }).limit(1, (err, recentMessages) => {
          if (err) {
            console.error("Error finding recent message:", err);
          }

          const recentMessage = recentMessages && recentMessages.length > 0 ? recentMessages[0] : null;

          conversationDetails.push({
            username: user.username,
            email: user.email,
            grade: user.grade,
            section: user.section,
            recentMessage: recentMessage ? {
              message: recentMessage.message,
              timestamp: recentMessage.timestamp,
              from: recentMessage.from === userEmail ? 'You' : user.username
            } : null
          });

          processedConversations++;
          if (processedConversations === users.length) {
            res.send({ conversations: conversationDetails });
          }
        });
      });
    });
  });
});

// Get messages between two users
app.get('/get-messages/:friendEmail', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const friendEmail = req.params.friendEmail;

  // Find messages between current user and friend
  messagesDb.find({
    $or: [
      { from: userEmail, to: friendEmail },
      { from: friendEmail, to: userEmail }
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
app.post('/send-help-request', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { grade, subject } = req.body;

  if (!grade || !subject) {
    return res.status(400).send({ success: false, message: 'Grade and subject are required' });
  }

  // Get current user info
  db.findOne({ email: userEmail }, (err, currentUser) => {
    if (err) {
      console.error("Error finding current user:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!currentUser) {
      return res.status(404).send({ success: false, message: 'User not found' });
    }

    // Find all users in grades 7-10 (excluding current user)
    db.find({ grade: { $in: ['7', '8', '9', '10'] }, email: { $ne: userEmail } }, (err, potentialHelpers) => {
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
        type: 'kastudy_request',
        fromUser: {
          username: currentUser.username,
          email: userEmail,
          grade: currentUser.grade
        },
        subject: subject,
        timestamp: new Date(),
        status: 'pending',
        message: `Good day, ${helper.username}! ${currentUser.username} (Grade ${currentUser.grade}) would like to ask for help with ${subject}. Would you be able to help them?`
      }));

      // Add notifications to each helper's profile
      let completed = 0;
      const total = potentialHelpers.length;

      potentialHelpers.forEach(helper => {
        db.update(
          { email: helper.email },
          { $push: { notifications: notifications.find(n => n.fromUser.email === userEmail) } },
          { upsert: true },
          (err, numReplaced) => {
            if (err) {
              console.error("Error adding notification:", err);
            }
            completed++;
            if (completed === total) {
              // Notify all connected users about new notifications
              notifications.forEach(notification => {
                if (connectedUsers[helper.email]) {
                  io.to(connectedUsers[helper.email]).emit('new_notification', notification);
                }
              });

              res.send({
                success: true,
                message: `Help request sent to ${total} students across all grades (7-10)!`
              });
            }
          }
        );
      });
    });
  });
});

// Get notifications endpoint
app.get('/get-notifications', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: userEmail }, (err, user) => {
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
app.post('/respond-help-request', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { notificationId, response, requesterEmail } = req.body;

  if (!notificationId || !response) {
    return res.status(400).send({ success: false, message: 'Notification ID and response are required' });
  }

  // Remove the notification from current user's notifications
  db.update(
    { email: userEmail },
    { $pull: { notifications: { id: notificationId } } },
    {},
    (err, numReplaced) => {
      if (err) {
        console.error("Error removing notification:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      if (response === 'accept' && requesterEmail) {
        // Get helper's name for the notification
        db.findOne({ email: userEmail }, (err, helper) => {
          if (err) {
            console.error("Error finding helper:", err);
            return res.status(500).send({ success: false, message: 'Server error' });
          }

          // Send notification to requester
          const successNotification = {
            id: Date.now() + Math.random(),
            type: 'kastudy_accepted',
            fromUser: {
              name: helper.name,
              surname: helper.surname,
              email: userEmail
            },
            subject: req.body.subject,
            timestamp: new Date(),
            message: `Hello, ${req.body.requesterName}! We bring good news! ${helper.name} ${helper.surname} wants to help you!`
          };

          db.update(
            { email: requesterEmail },
            { $push: { notifications: successNotification } },
            { upsert: true },
            (err, numReplaced) => {
              if (err) {
                console.error("Error sending success notification:", err);
              }

              // Notify the requester in real-time
              if (connectedUsers[requesterEmail]) {
                io.to(connectedUsers[requesterEmail]).emit('new_notification', successNotification);
              }

              res.send({ success: true, message: 'Help request accepted! Starting chat...' });
            }
          );
        });
      } else {
        res.send({ success: true, message: 'Help request declined.' });
      }
    }
  );
});

// Handle kastudy request response
app.post('/respond-kastudy-request', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { notificationId, response, requesterEmail, subject, requesterName } = req.body;

  if (!notificationId || !response) {
    return res.status(400).send({ success: false, message: 'Notification ID and response are required' });
  }

  // Remove the notification from current user's notifications
  db.update(
    { email: userEmail },
    { $pull: { notifications: { id: notificationId } } },
    {},
    (err, numReplaced) => {
      if (err) {
        console.error("Error removing notification:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      if (response === 'accept' && requesterEmail) {
        // Get helper's name for the notification
        db.findOne({ email: userEmail }, (err, helper) => {
          if (err) {
            console.error("Error finding helper:", err);
            return res.status(500).send({ success: false, message: 'Server error' });
          }

          // Send notification to requester
          const successNotification = {
            id: Date.now() + Math.random(),
            type: 'kastudy_accepted',
            fromUser: {
              username: helper.username,
              email: userEmail
            },
            subject: subject,
            timestamp: new Date(),
            message: `Hello, ${requesterName}! We bring good news! ${helper.username} wants to help you!`
          };

          db.update(
            { email: requesterEmail },
            { $push: { notifications: successNotification } },
            { upsert: true },
            (err, numReplaced) => {
              if (err) {
                console.error("Error sending success notification:", err);
              }

              // Notify the requester in real-time
              if (connectedUsers[requesterEmail]) {
                io.to(connectedUsers[requesterEmail]).emit('new_notification', successNotification);
              }

              res.send({ success: true, message: 'Help request accepted! Starting chat...' });
            }
          );
        });
      } else {
        res.send({ success: true, message: 'Help request declined.' });
      }
    }
  );
});


// Quiz endpoints
app.post('/save-quiz', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
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
    { email: userEmail },
    { $push: { quizzes: quizData } },
    { upsert: true },
    (err, numReplaced) => {
      if (err) {
        console.error("Error saving quiz:", err);
        return res.status(500).send({ success: false, message: 'Server error saving quiz' });
      }

      console.log(`Quiz "${quizName}" saved for user ${userEmail}`);
      res.send({ success: true, message: 'Quiz saved successfully' });
    }
  );
});

app.get('/get-quizzes', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  db.findOne({ email: userEmail }, (err, user) => {
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

      // Get sender's username for display
      db.findOne({ email: from }, (err, sender) => {
        if (err) {
          console.error("Error finding sender:", err);
          return;
        }

        const senderUsername = sender ? sender.username : from;

        // Emit to recipient if online
        const recipientSocket = connectedUsers[to];
        if (recipientSocket) {
          io.to(recipientSocket).emit('receive message', {
            from: senderUsername,
            fromEmail: from,
            message,
            timestamp
          });
        }

        // Emit to sender for consistency
        socket.emit('receive message', {
          from: senderUsername,
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
  console.log(`--- Server running at http://localhost:${PORT} ---`);
  console.log(`--- Notification-based verification enabled (no email sending) ---`);
});