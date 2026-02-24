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
const nodemailer = require('nodemailer');
const sgMail = require('@sendgrid/mail');
const saltRounds = 10;

console.log("--- SERVER.JS UPDATED - SENDGRID EMAIL VERIFICATION ENABLED ---");

// Configure SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("SendGrid configured successfully");
}

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
const activityDb = new Datastore({ filename: 'activity.db', autoload: true });

// Store connected users (declared early for use in endpoints)
const connectedUsers = {};
const activeUserSessions = {}; // Track active user sessions with their details

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

// Send verification code via SENDGRID EMAIL
app.post('/send-code', (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).send({ success: false, message: 'Email is required.' });
  }

  // Normalize email to lowercase
  const normalizedEmail = email.toLowerCase();

  // Generate a random 6-digit code
  currentCode = Math.floor(100000 + Math.random() * 900000).toString();
  codeEmail = normalizedEmail;

  console.log("Generated verification code " + currentCode + " for " + normalizedEmail);

  // Send email with OTP via SendGrid
  const msg = {
    to: normalizedEmail,
    from: process.env.EMAIL_USER,
    subject: 'Your StudyMatch Verification Code',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #2E7D32, #4CAF50); padding: 20px; border-radius: 10px 10px 0 0;">
          <h2 style="color: #FFD700; margin: 0; text-align: center;">StudyMatch CSHSB</h2>
        </div>
        <div style="background: #ffffff; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h3 style="color: #2E7D32; margin-top: 0;">Verification Code</h3>
          <p>Your verification code is:</p>
          <div style="background: linear-gradient(135deg, #2E7D32, #4CAF50); color: white; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 20px 0; border-radius: 8px;">
            ${currentCode}
          </div>
          <p style="color: #666;">This code will expire in 10 minutes.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">If you didn't request this code, please ignore this email.</p>
        </div>
      </div>
    `
  };

  sgMail.send(msg).then(() => {
    console.log('SendGrid email sent successfully');
    res.send({ 
      success: true, 
      message: 'Verification code sent to your email.'
    });
  }).catch((error) => {
    console.error('SendGrid error:', error);
    // Fallback: return code if email fails
    res.send({ 
      success: true, 
      code: currentCode,
      message: 'Email service unavailable, showing code in notification.'
    });
  });
});

// Verify code endpoint
app.post('/verify-code', (req, res) => {
  const { email, code, isLogin } = req.body;
  
  // Normalize email to lowercase
  const normalizedEmail = email.toLowerCase();

  if (!email || !code) {
    return res.status(400).send({ success: false, message: 'Email and code are required.' });
  }

  // Check if code matches
  if (normalizedEmail !== codeEmail || code !== currentCode) {
    return res.send({ success: false, message: "Verification code is incorrect. Please try again." });
  }

  // Check if user exists in database
  db.findOne({ email: normalizedEmail }, (err, user) => {
    if (err) {
      console.error("Database error:", err);
      return res.status(500).send({ success: false, message: "Server error." });
    }

    if (isLogin) {
      // For login, user must exist
      if (user) {
        storedEmail = normalizedEmail;
        res.send({ success: true, isNewUser: false });
      } else {
        res.send({ success: false, message: "No account found with this email. Please sign up." });
      }
    } else {
      // For signup, user must not exist
      if (user) {
        res.send({ success: false, message: "An account with this email already exists. Please log in." });
      } else {
        storedEmail = normalizedEmail;
        res.send({ success: true, isNewUser: true });
      }
    }
  });
});

// Registration endpoint - saves user directly to database
app.post('/register', async (req, res) => {
  const { name, email, password, isAdmin } = req.body;

  if (!name || !email || !password) {
    return res.status(400).send({ success: false, message: 'All fields are required.' });
  }

  // Normalize email to lowercase for consistency
  const normalizedEmail = email.toLowerCase();
  
  // Check if user already exists
  db.findOne({ email: normalizedEmail }, async (err, existingUser) => {
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
        email: normalizedEmail,
        password: hash,
        createdAt: new Date(),
        profileComplete: false, // Flag to indicate profile setup is needed
        isAdmin: isAdmin || false // Store admin flag
      };

      db.insert(userData, async (err, newDoc) => {
        if (err) {
          console.error("Error saving user:", err);
          return res.status(500).send({ success: false, message: 'Server error saving user.' });
        }

        console.log("User registered successfully:", normalizedEmail, "isAdmin:", isAdmin);

        // Create session for the new user
        try {
          await createSession(normalizedEmail, res);
          storedEmail = normalizedEmail;
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
  const normalizedEmail = email.toLowerCase();
  
  db.findOne({ email: normalizedEmail }, async (err, user) => {
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

// New endpoint: Lookup LRN and return student info
app.post('/lookup-lrn', (req, res) => {
  const { lrn } = req.body;

  if (!lrn) {
    return res.status(400).send({ success: false, message: 'LRN is required.' });
  }

  fs.readFile('allowed-lrns.json', 'utf8', (err, data) => {
    if (err) {
      console.error("Error reading LRN file:", err);
      return res.status(500).send({ success: false, message: 'Server error checking LRN.' });
    }

    const lrnData = JSON.parse(data);
    const student = lrnData.students.find(s => s.lrn === lrn);

    if (!student) {
      return res.status(403).send({ success: false, message: 'This LRN is not found in our records. Please contact your administrator.' });
    }

    // Check if LRN is already used
    if (student.used) {
      return res.status(403).send({ success: false, message: 'This LRN has already been registered. Each LRN can only be used once.' });
    }

    res.send({ 
      success: true, 
      student: {
        firstName: student.firstName,
        surname: student.surname,
        lrn: student.lrn,
        grade: student.grade,
        section: student.section,
        isAdmin: student.isAdmin || false
      }
    });
  });
});

// New endpoint: Check username availability
app.post('/check-username', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).send({ available: false, message: 'Username is required.' });
  }

  // Check if username already exists in database
  db.findOne({ username: username.toLowerCase() }, (err, user) => {
    if (err) {
      console.error("Error checking username:", err);
      return res.status(500).send({ available: false, message: 'Server error checking username.' });
    }

    if (user) {
      return res.send({ available: false, message: 'Username is already taken.' });
    }

    res.send({ available: true, message: 'Username is available.' });
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
        message: "LRN " + lrn + " is only valid for " + student.firstName + " " + student.surname + ". Please check your name and try again."
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

  // Check if user is admin
  db.findOne({ email: email }, (err, user) => {
    if (err) {
      console.error("Error finding user:", err);
      return res.status(500).send({ success: false, message: 'Server error.' });
    }

    const isAdmin = user && user.isAdmin;

    const profileData = {
      name: req.body.name,
      surname: req.body.surname,
      username: req.body.username,
      lrn: req.body.lrn,
      grade: isAdmin ? null : req.body.grade,
      section: isAdmin ? null : req.body.section,
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
    console.log("Profile updated for email: " + userEmail);
    res.send({ success: true, message: 'Profile updated successfully!' });
  });
});

// To-Do List Endpoints
app.get('/get-todos', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  console.log('[/get-todos] userEmail:', userEmail);
  if (!userEmail) {
    console.log('[/get-todos] No session found, returning 401');
    return res.status(401).send([]);
  }
  console.log('[/get-todos] Fetching todos for:', userEmail);
  todosDb.find({ userEmail: userEmail }, (err, docs) => {
    if (err) {
      console.error('[/get-todos] Database error:', err);
      return res.status(500).send([]);
    }
    console.log('[/get-todos] Found todos:', docs.length);
    res.send(docs);
  });
});

app.post('/add-todo', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  console.log('[/add-todo] userEmail:', userEmail);
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
  console.log('[/add-todo] Creating todo:', newTodo);
  todosDb.insert(newTodo, (err, doc) => {
    if (err) {
      console.error('[/add-todo] Database error:', err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }
    console.log('[/add-todo] Todo created successfully, id:', doc._id);
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

// Note: The send-help-request endpoint uses 'transporter' which is not defined.
// This functionality requires nodemailer to be configured.
// If you need email functionality, uncomment the following and configure nodemailer:
// const nodemailer = require('nodemailer');
// const transporter = nodemailer.createTransport({ /* your config */ });

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

// Find a Study Buddy (KaStudy) endpoint - sends notifications to other users
app.post('/find-kastudy', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { grade, subject } = req.body;
  
  console.log('[/find-kastudy] Received request - grade:', grade, 'subject:', subject, 'from:', userEmail);

  if (!grade || !subject) {
    return res.status(400).send({ success: false, message: 'Grade and subject are required.' });
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

    console.log('[/find-kastudy] Current user:', currentUser.username);

    // Find all users (excluding current user) to send notification to everyone
    db.find({ 
      email: { $ne: userEmail } 
    }, (err, potentialHelpers) => {
      if (err) {
        console.error("Error finding potential helpers:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      console.log('[/find-kastudy] Found', potentialHelpers.length, 'potential helpers');

      if (potentialHelpers.length === 0) {
        return res.send({ success: true, message: 'No other registered users found.' });
      }

      // Create notification object (single notification for all helpers)
      const notification = {
        id: Date.now() + Math.random(),
        type: 'help_request',
        fromUser: {
          username: currentUser.username,
          email: userEmail,
          grade: currentUser.grade
        },
        subject: subject,
        timestamp: new Date(),
        status: 'pending',
        message: currentUser.username + " needs help in " + subject + ". Would you like to help them?"
      };

      // Log the activity
      const activityLog = {
        type: 'help_request',
        userEmail: userEmail,
        username: currentUser.username,
        name: currentUser.name,
        surname: currentUser.surname,
        subject: subject,
        timestamp: new Date(),
        description: currentUser.name + " " + currentUser.surname + " needs help in " + subject + "."
      };
      
      activityDb.insert(activityLog, (err) => {
        if (err) console.error("Error logging activity:", err);
      });

      // Add notification to each helper's profile
      let completed = 0;
      const total = potentialHelpers.length;

      potentialHelpers.forEach(helper => {
        console.log('[/find-kastudy] Adding notification to helper:', helper.email);
        
        db.update(
          { email: helper.email },
          { $push: { notifications: notification } },
          { upsert: true },
          (err, numReplaced) => {
            if (err) {
              console.error("Error adding notification:", err);
            } else {
              console.log('[/find-kastudy] Notification added to:', helper.email);
              
              // Try to send real-time notification
              const socketId = connectedUsers[helper.email.toLowerCase()];
              if (socketId) {
                console.log('[/find-kastudy] Sending real-time notification to:', helper.email, 'socket:', socketId);
                io.to(socketId).emit('new_notification', notification);
              } else {
                console.log('[/find-kastudy] Helper not connected via socket:', helper.email);
              }
            }
            completed++;
            if (completed === total) {
              console.log('[/find-kastudy] All notifications sent. Total:', total);
              res.send({
                success: true,
                message: "Help request sent to all " + total + " registered users!"
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

          // Get requester's info
          db.findOne({ email: requesterEmail }, (err, requester) => {
            if (!err && requester) {
              // Log the activity - helper wants to help requester
              const activityLog = {
                type: 'helper_volunteers',
                helperEmail: userEmail,
                helperUsername: helper.username,
                helperName: helper.name,
                helperSurname: helper.surname,
                requesterEmail: requesterEmail,
                requesterUsername: requester.username,
                requesterName: requester.name,
                requesterSurname: requester.surname,
                subject: req.body.subject,
                timestamp: new Date(),
                description: helper.name + " " + helper.surname + " wants to help " + requester.name + " " + requester.surname + " in " + req.body.subject + "."
              };
              
              activityDb.insert(activityLog, (err) => {
                if (err) console.error("Error logging activity:", err);
              });
            }
          });

          // Create a chat session
          const chatSession = {
            user1: requesterEmail,
            user2: userEmail,
            requester: requesterEmail,
            helper: userEmail,
            subject: req.body.subject,
            active: true,
            createdAt: new Date()
          };

          chatSessionsDb.insert(chatSession, (err, newSession) => {
            if (err) {
              console.error("Error creating chat session:", err);
            }

            // Send notification to requester
            const successNotification = {
              id: Date.now() + Math.random(),
              type: 'kastudy_accepted',
              fromUser: {
                name: helper.name,
                surname: helper.surname,
                username: helper.username,
                email: userEmail
              },
              subject: req.body.subject,
              timestamp: new Date(),
              message: helper.username + " accepted your help request for " + req.body.subject + "! Start chatting now!",
              redirectUrl: '/chats.html?chat=' + userEmail
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
                const requesterSocket1 = connectedUsers[requesterEmail.toLowerCase()];
                if (requesterSocket1) {
                  io.to(requesterSocket1).emit('new_notification', successNotification);
                }

                res.send({ 
                  success: true, 
                  message: 'Help request accepted! Starting chat...',
                  redirectUrl: '/chats.html?chat=' + requesterEmail
                });
              }
            );
          });
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

          // Get requester's info
          db.findOne({ email: requesterEmail }, (err, requester) => {
            if (!err && requester) {
              // Log the activity - helper accepts to help requester
              const activityLog = {
                type: 'help_accepted',
                helperEmail: userEmail,
                helperUsername: helper.username,
                helperName: helper.name,
                helperSurname: helper.surname,
                requesterEmail: requesterEmail,
                requesterUsername: requester.username,
                requesterName: requester.name,
                requesterSurname: requester.surname,
                subject: subject,
                timestamp: new Date(),
                description: requester.name + " " + requester.surname + " accepted " + helper.name + " " + helper.surname + "'s help in " + subject + "."
              };
              
              activityDb.insert(activityLog, (err) => {
                if (err) console.error("Error logging activity:", err);
              });
            }
          });

          // Create a chat session
          const chatSession = {
            user1: requesterEmail,
            user2: userEmail,
            requester: requesterEmail,
            helper: userEmail,
            subject: subject,
            active: true,
            createdAt: new Date()
          };

          chatSessionsDb.insert(chatSession, (err, newSession) => {
            if (err) {
              console.error("Error creating chat session:", err);
              return res.status(500).send({ success: false, message: 'Server error' });
            }

            // Send notification to requester with redirect to chat
            const successNotification = {
              id: Date.now() + Math.random(),
              type: 'kastudy_accepted',
              fromUser: {
                username: helper.username,
                email: userEmail
              },
              subject: subject,
              timestamp: new Date(),
              message: "Hello, " + requesterName + "! We bring good news! " + helper.username + " wants to help you!",
              redirectUrl: '/chats.html?chat=' + userEmail
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
                const requesterSocket2 = connectedUsers[requesterEmail.toLowerCase()];
                if (requesterSocket2) {
                  io.to(requesterSocket2).emit('new_notification', successNotification);
                }

                res.send({ 
                  success: true, 
                  message: 'Help request accepted! Starting chat...',
                  redirectUrl: '/chats.html?chat=' + requesterEmail
                });
              }
            );
          });
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

      console.log('Quiz "' + quizName + '" saved for user ' + userEmail);
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

// New Chat System Endpoints

// Create a new database for chat sessions
const chatSessionsDb = new Datastore({ filename: 'chat-sessions.db', autoload: true });

// Get active chat sessions for a user
app.get('/get-active-chats', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  chatSessionsDb.find({
    $or: [
      { user1: userEmail },
      { user2: userEmail }
    ],
    active: true
  }, (err, sessions) => {
    if (err) {
      console.error("Error finding chat sessions:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (sessions.length === 0) {
      return res.send({ chats: [] });
    }

    // Get partner details for each session
    const partnerEmails = sessions.map(s => s.user1 === userEmail ? s.user2 : s.user1);
    
    db.find({ email: { $in: partnerEmails } }, (err, users) => {
      if (err) {
        console.error("Error finding users:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      const chats = sessions.map(session => {
        const partnerEmail = session.user1 === userEmail ? session.user2 : session.user1;
        const partner = users.find(u => u.email === partnerEmail);
        
        return {
          sessionId: session._id,
          partnerEmail: partnerEmail,
          partnerUsername: partner ? partner.username : partnerEmail,
          subject: session.subject,
          createdAt: session.createdAt
        };
      });

      res.send({ chats });
    });
  });
});

// Get helped lists
app.get('/get-helped-lists', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Find closed chat sessions where user was involved
  chatSessionsDb.find({
    $or: [
      { user1: userEmail },
      { user2: userEmail }
    ],
    active: false
  }, (err, sessions) => {
    if (err) {
      console.error("Error finding closed sessions:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (sessions.length === 0) {
      return res.send({ helpedByMe: [], helpedMe: [] });
    }

    // Separate into helped by me and helped me
    const helpedByMeEmails = sessions.filter(s => s.helper === userEmail).map(s => s.requester);
    const helpedMeEmails = sessions.filter(s => s.requester === userEmail).map(s => s.helper);

    const allEmails = [...new Set([...helpedByMeEmails, ...helpedMeEmails])];

    if (allEmails.length === 0) {
      return res.send({ helpedByMe: [], helpedMe: [] });
    }

    db.find({ email: { $in: allEmails } }, (err, users) => {
      if (err) {
        console.error("Error finding users:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      const helpedByMe = helpedByMeEmails.map(email => {
        const user = users.find(u => u.email === email);
        return user ? { username: user.username, email: user.email } : null;
      }).filter(u => u !== null);

      const helpedMe = helpedMeEmails.map(email => {
        const user = users.find(u => u.email === email);
        return user ? { username: user.username, email: user.email } : null;
      }).filter(u => u !== null);

      res.send({ helpedByMe, helpedMe });
    });
  });
});

// Close a chat session
app.post('/close-chat', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  const { partnerEmail } = req.body;

  if (!partnerEmail) {
    return res.status(400).send({ success: false, message: 'Partner email is required' });
  }

  // Find and close the chat session
  chatSessionsDb.findOne({
    $or: [
      { user1: userEmail, user2: partnerEmail },
      { user1: partnerEmail, user2: userEmail }
    ],
    active: true
  }, (err, session) => {
    if (err) {
      console.error("Error finding session:", err);
      return res.status(500).send({ success: false, message: 'Server error' });
    }

    if (!session) {
      return res.status(404).send({ success: false, message: 'Chat session not found' });
    }

    // Mark session as closed
    chatSessionsDb.update(
      { _id: session._id },
      { $set: { active: false, closedAt: new Date(), closedBy: userEmail } },
      {},
      (err, numReplaced) => {
        if (err) {
          console.error("Error closing session:", err);
          return res.status(500).send({ success: false, message: 'Server error' });
        }

        // Notify the other user via socket
        const partnerSocket = connectedUsers[partnerEmail.toLowerCase()];
        if (partnerSocket) {
          io.to(partnerSocket).emit('chat_closed', { partnerEmail: userEmail });
        }

        res.send({ success: true, message: 'Chat closed successfully' });
      }
    );
  });
});

// File upload endpoint
const multer = require('multer');
const path = require('path');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'public/uploads/chat-files';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

app.post('/upload-chat-file', upload.single('file'), async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  if (!req.file) {
    return res.status(400).send({ success: false, message: 'No file uploaded' });
  }

  const { to } = req.body;
  if (!to) {
    return res.status(400).send({ success: false, message: 'Recipient email is required' });
  }

  const fileUrl = '/uploads/chat-files/' + req.file.filename;
  const timestamp = new Date();

  // Store message with file in database
  const messageData = {
    from: userEmail,
    to: to,
    message: '',
    fileUrl: fileUrl,
    fileName: req.file.originalname,
    fileType: req.file.mimetype,
    timestamp: timestamp,
    conversationId: [userEmail, to].sort().join('_')
  };

  messagesDb.insert(messageData, (err, newDoc) => {
    if (err) {
      console.error("Error saving message:", err);
      return res.status(500).send({ success: false, message: 'Error saving message' });
    }

    // Get sender's username
    db.findOne({ email: userEmail }, (err, sender) => {
      if (err) {
        console.error("Error finding sender:", err);
        return res.send({ success: true, fileUrl });
      }

      const senderUsername = sender ? sender.username : userEmail;

      // Emit to recipient if online
      const recipientSocket = connectedUsers[to.toLowerCase()];
      if (recipientSocket) {
        io.to(recipientSocket).emit('receive message', {
          from: senderUsername,
          fromEmail: userEmail,
          message: '',
          fileUrl: fileUrl,
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          timestamp: timestamp
        });
      }

      // Emit to sender
      const senderSocket = connectedUsers[userEmail.toLowerCase()];
      if (senderSocket) {
        io.to(senderSocket).emit('receive message', {
          from: senderUsername,
          fromEmail: userEmail,
          message: '',
          fileUrl: fileUrl,
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          timestamp: timestamp
        });
      }

      res.send({ success: true, fileUrl });
    });
  });
});

// Get active users endpoint
app.get('/get-active-users', async (req, res) => {
  try {
    // Get all active user emails
    const activeEmails = Object.keys(activeUserSessions);
    
    if (activeEmails.length === 0) {
      return res.send({ success: true, activeUsers: [], totalActive: 0 });
    }

    // Get user details from database
    db.find({ email: { $in: activeEmails } }, (err, users) => {
      if (err) {
        console.error("Error finding active users:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      const activeUsers = users.map(user => ({
        username: user.username,
        email: user.email,
        grade: user.grade,
        section: user.section
      }));

      res.send({ 
        success: true, 
        activeUsers: activeUsers,
        totalActive: activeUsers.length
      });
    });
  } catch (error) {
    console.error("Error in get-active-users:", error);
    res.status(500).send({ success: false, message: 'Server error' });
  }
});

// Admin endpoints
app.get('/admin/get-all-users', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Check if user is admin
  db.findOne({ email: userEmail }, (err, user) => {
    if (err || !user || !user.isAdmin) {
      return res.status(403).send({ success: false, message: 'Admin access required' });
    }

    // Get all users except admins
    db.find({ isAdmin: { $ne: true } }, (err, users) => {
      if (err) {
        console.error("Error finding users:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      const userList = users.map(u => ({
        username: u.username,
        name: u.name,
        surname: u.surname,
        lrn: u.lrn,
        grade: u.grade,
        section: u.section,
        email: u.email
      }));

      res.send({ success: true, users: userList });
    });
  });
});

app.get('/admin/get-active-users-detailed', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Check if user is admin
  db.findOne({ email: userEmail }, (err, user) => {
    if (err || !user || !user.isAdmin) {
      return res.status(403).send({ success: false, message: 'Admin access required' });
    }

    // Get all active user emails
    const activeEmails = Object.keys(activeUserSessions);
    
    if (activeEmails.length === 0) {
      return res.send({ success: true, users: [] });
    }

    // Get user details from database
    db.find({ email: { $in: activeEmails }, isAdmin: { $ne: true } }, (err, users) => {
      if (err) {
        console.error("Error finding active users:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      const userList = users.map(u => ({
        username: u.username,
        name: u.name,
        surname: u.surname,
        lrn: u.lrn,
        grade: u.grade,
        section: u.section,
        email: u.email
      }));

      res.send({ success: true, users: userList });
    });
  });
});

// Admin: Get activity logs
app.get('/admin/get-activity-logs', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Check if user is admin
  db.findOne({ email: userEmail }, (err, user) => {
    if (err || !user || !user.isAdmin) {
      return res.status(403).send({ success: false, message: 'Admin access required' });
    }

    // Get all activity logs, sorted by newest first
    activityDb.find({}).sort({ timestamp: -1 }).limit(100, (err, logs) => {
      if (err) {
        console.error("Error finding activity logs:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      res.send({ success: true, logs: logs });
    });
  });
});

// Admin: Get helping rankings
app.get('/admin/get-helping-rankings', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Check if user is admin
  db.findOne({ email: userEmail }, (err, user) => {
    if (err || !user || !user.isAdmin) {
      return res.status(403).send({ success: false, message: 'Admin access required' });
    }

    // Get all closed chat sessions where someone was helped
    chatSessionsDb.find({ active: false }, (err, sessions) => {
      if (err) {
        console.error("Error finding sessions:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      // Count how many times each user helped others
      const helperCounts = {};
      sessions.forEach(session => {
        if (session.helper) {
          if (!helperCounts[session.helper]) {
            helperCounts[session.helper] = 0;
          }
          helperCounts[session.helper]++;
        }
      });

      // Convert to array and sort
      const rankings = Object.entries(helperCounts)
        .map(([email, count]) => ({ email, count }))
        .sort((a, b) => b.count - a.count);

      // Get user details for each helper
      const helperEmails = rankings.map(r => r.email);
      
      if (helperEmails.length === 0) {
        return res.send({ success: true, rankings: [] });
      }

      db.find({ email: { $in: helperEmails } }, (err, users) => {
        if (err) {
          console.error("Error finding users:", err);
          return res.status(500).send({ success: false, message: 'Server error' });
        }

        const rankingsWithDetails = rankings.map(r => {
          const u = users.find(user => user.email === r.email);
          return {
            rank: rankings.indexOf(r) + 1,
            email: r.email,
            username: u ? u.username : r.email,
            name: u ? u.name : '',
            surname: u ? u.surname : '',
            count: r.count
          };
        });

        res.send({ success: true, rankings: rankingsWithDetails });
      });
    });
  });
});

// Get weekly study partner recommendations
app.get('/get-weekly-recommendations', async (req, res) => {
  const userEmail = await getUserFromSession(req);
  if (!userEmail) {
    return res.status(401).send({ success: false, message: 'Unauthorized' });
  }

  // Get current user's profile
  db.findOne({ email: userEmail }, (err, currentUser) => {
    if (err || !currentUser) {
      return res.status(404).send({ success: false, message: 'User not found' });
    }

    // Get user's signup week
    const signupDate = new Date(currentUser.createdAt);
    const now = new Date();
    const weeksSinceSignup = Math.floor((now - signupDate) / (7 * 24 * 60 * 60 * 1000));
    
    // Check if it's been at least a week since signup
    if (weeksSinceSignup < 1) {
      return res.send({ 
        success: true, 
        recommendations: [],
        message: 'Check back next week for your study partner recommendations!',
        weeksActive: weeksSinceSignup
      });
    }

    // Get user's strengths and weaknesses
    const userStrengths = currentUser.strengths || [];
    const userWeaknesses = currentUser.weaknesses || [];
    const userGrade = currentUser.grade;
    const userSection = currentUser.section;

    // Find users where:
    // 1. They have strengths that match current user's weaknesses (can help you)
    // 2. Current user's strengths match their weaknesses (you can help them)
    // 3. Same grade and section preferred
    db.find({ 
      email: { $ne: userEmail },
      grade: userGrade,
      section: userSection,
      profileComplete: true
    }, (err, potentialPartners) => {
      if (err) {
        console.error("Error finding potential partners:", err);
        return res.status(500).send({ success: false, message: 'Server error' });
      }

      // Score each potential partner
      const scoredPartners = potentialPartners.map(partner => {
        const partnerStrengths = partner.strengths || [];
        const partnerWeaknesses = partner.weaknesses || [];

        // Calculate how well they can help you (they have strengths in your weaknesses)
        const canHelpYou = userWeaknesses.filter(w => partnerStrengths.includes(w)).length;
        
        // Calculate how well you can help them
        const youCanHelp = partnerWeaknesses.filter(w => userStrengths.includes(w)).length;
        
        // Total compatibility score
        const score = canHelpYou + youCanHelp;

        return {
          email: partner.email,
          username: partner.username,
          name: partner.name,
          surname: partner.surname,
          grade: partner.grade,
          section: partner.section,
          strengths: partnerStrengths,
          weaknesses: partnerWeaknesses,
          canHelpYou: canHelpYou,
          youCanHelp: youCanHelp,
          score: score
        };
      });

      // Sort by score and take top recommendations
      const recommendations = scoredPartners
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      res.send({ 
        success: true, 
        recommendations: recommendations,
        weeksActive: weeksSinceSignup,
        message: recommendations.length > 0 
          ? `Found ${recommendations.length} recommended study partners for you!`
          : 'No compatible study partners found yet. Try updating your subjects!'
      });
    });
  });
});

const server = http.createServer(app);
const io = socketIo(server);

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', (email) => {
    const normalizedEmail = email.toLowerCase();
    connectedUsers[normalizedEmail] = socket.id;
    socket.email = normalizedEmail;
    
    // Add to active user sessions
    db.findOne({ email: normalizedEmail }, (err, user) => {
      if (!err && user) {
        activeUserSessions[normalizedEmail] = {
          username: user.username,
          grade: user.grade,
          section: user.section,
          connectedAt: new Date()
        };
        
        // Broadcast to all clients that a user connected
        io.emit('user_connected', { email: normalizedEmail });
      }
    });
    
    console.log(normalizedEmail + ' joined with socket ' + socket.id);
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
        const recipientSocket = connectedUsers[to.toLowerCase()];
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
      delete activeUserSessions[socket.email];
      
      // Broadcast to all clients that a user disconnected
      io.emit('user_disconnected', { email: socket.email });
      
      console.log(socket.email + ' disconnected');
    }
  });
});

server.listen(PORT, () => {
  console.log("--- Server running at http://localhost:" + PORT + " ---");
  console.log("--- SendGrid email verification enabled ---");
});
