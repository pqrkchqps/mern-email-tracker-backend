const express = require("express");
const mongoose = require("mongoose");
const socket = require("socket.io");
const nodemailer = require("nodemailer");
const Imap = require("node-imap");
const DomParser = require("dom-parser");
const parser = new DomParser();
inspect = require("util").inspect;

require("dotenv").config();

const cors = require("cors");
var corsOptions = {
  origin: "http://localhost:3000",
  optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
};

// Create the Express application
const app = express();

// Configure the body parser middleware to parse JSON data
app.use(express.json());

app.use(cors(corsOptions));

// Connect to MongoDB
mongoose.connect("mongodb://127.0.0.1/email-tracker", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Create a MongoDB model for emails
const Email = mongoose.model("Email", {
  body: String,
  date: String,
  from: [String],
  to: [String],
  subject: String,
  tags: [String],
});

// Set up nodemailer for sending emails
// const transporter = nodemailer.createTransport({
//   host: "your-email-host",
//   port: 587,
//   auth: {
//     user: "your-email-username",
//     pass: "your-email-password",
//   },
// });

// IMAP configuration
const imapConfig = {
  user: process.env.USER,
  password: process.env.PASS,
  host: process.env.IMAP_HOST,
  port: 993,
  tls: true,
  authTimeout: 10000,
  connTimeout: 30000,
};

// Function to fetch emails using IMAP
const fetchEmails = () => {
  const imap = new Imap(imapConfig);

  imap.once("ready", () => {
    console.log("ready");
    imap.openBox("INBOX", false, (err, box) => {
      if (err) {
        console.error("Error:", err);
        return;
      }

      const searchCriteria = ["UNSEEN"]; // Fetch only unread emails
      const fetchOptions = {
        bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
        markSeen: true,
        struct: true,
      };
      imap.search(searchCriteria, (err, results) => {
        if (err) throw err;

        if (results.length > 0) {
          const fetch = imap.fetch(results, fetchOptions);

          fetch.on("message", (msg, seqno) => {
            let email = { text: "", image: "" };

            msg.on("body", (stream, info) => {
              const chunks = [];

              stream.on("data", (chunk) => {
                chunks.push(chunk);
              });

              stream.on("end", () => {
                const data = Buffer.concat(chunks).toString("utf8");

                if (info.which === "TEXT") {
                  var dom = parser.parseFromString(data);
                  email.body = dom.getElementsByTagName("body")[0].innerHTML;
                } else if (
                  info.which === "HEADER.FIELDS (FROM TO SUBJECT DATE)"
                ) {
                  let header = Imap.parseHeader(data);
                  email.from = header.from;
                  email.to = header.to;
                  email.subject = header.subject[0];
                  email.date = header.date[0];
                }
              });
            });

            msg.once("end", () => {
              console.log(email);
              // Save the email to the database
              const newEmail = new Email(email);
              newEmail.save().then((newEmail) => {
                console.log("email saved");
                // Emit the new email to connected clients in real-time
                io.emit("newEmail", newEmail);
              });
            });
          });

          fetch.once("error", (err) => {
            console.error("Fetch error:", err);
          });

          fetch.once("end", () => {
            imap.end();
          });
        }
      });
    });
  });

  imap.once("error", (err) => {
    console.error("IMAP error:", err);
  });

  imap.once("end", () => {
    console.log("IMAP connection ended");
  });

  imap.connect();
};

// Fetch emails periodically
setInterval(fetchEmails, 30000); // Fetch emails every 1 minute

// GET route to retrieve all emails
app.get("/emails", (req, res) => {
  Email.find({})
    .then((emails) => {
      res.json(emails);
    })
    .catch((err) => {
      console.error("Error:", err);
      res.status(500).json({ error: "Server error" });
    });
});

// POST route for receiving new emails
app.post("/emails", (req, res) => {
  const { body, subject, date, to, from } = req.body;

  // Save the email to the database
  const email = new Email({ body, subject, date, to, from });
  email.save();

  // Emit the new email to connected clients in real-time
  io.emit("newEmail", email);

  res.status(201).json(email);
});

// GET route for searching emails by text
app.get("/emails/search", (req, res) => {
  const { searchText } = req.query;

  const regex = new RegExp(searchText, "i");

  Email.find({ body: regex })
    .then((emails) => {
      res.json(emails);
    })
    .catch((err) => {
      console.error("Error:", err);
      res.status(500).json({ error: "Server error" });
    });
});

// POST route for creating tags
app.post("/emails/:id/tags", (req, res) => {
  const { id } = req.params;
  const { tags } = req.body;

  Email.findByIdAndUpdate(id, { $addToSet: { tags } }, { new: true })
    .then((email) => {
      res.json(email);
    })
    .catch((err) => {
      console.error("Error:", err);
      res.status(500).json({ error: "Server error" });
    });
});

// GET route for filtering emails by tag
app.get("/emails/filter", (req, res) => {
  const { tag } = req.query;

  Email.find({ tags: { $in: [tag] } })
    .then((emails) => {
      res.json(emails);
    })
    .catch((err) => {
      console.error("Error:", err);
      res.status(500).json({ error: "Server error" });
    });
});

// DELETE route to delete an email by ID
app.delete("/emails/:id", (req, res) => {
  const { id } = req.params;
  console.log("delete email with id " + id);

  Email.findByIdAndRemove(id)
    .then((email) => {
      if (!email) {
        res.status(404).json({ error: "Email not found" });
      } else {
        res.json({ message: "Email deleted successfully" });
      }
    })
    .catch((err) => {
      console.error("Error:", err);
      res.status(500).json({ error: "Server error" });
    });
});

// Set up the server to listen on port 5000
const server = app.listen(5000, () => {
  console.log("Server is running on port 5000");
});

const io = socket(server);
let aliveSockets = [];

// broadcasting ping
setInterval(function () {
  io.emit("ping", { timestamp: new Date().getTime() });
  console.log("sent ping");
}, 5000); // 10 seconds

// cleaning up stalled socket which does not answer to ping
setInterval(function () {
  //console.log(inspect(aliveSockets.length));
  for (idx in aliveSockets) {
    if (!aliveSockets[idx]) {
      return;
    }
    if (aliveSockets[idx].lastPong + 30 < new Date().getTime() / 1000) {
      aliveSockets[idx].socket.disconnect(0);
      delete aliveSockets[idx];
      console.error("delete connection");
    }
  }
}, 5000); // 1 second

io.on("connection", function (socket) {
  console.log("open connection");
  aliveSockets[socket.id] = { socket, lastPong: new Date().getTime() / 1000 };

  socket.on("pong", function () {
    console.log("got pong");
    aliveSockets[socket.id] = {
      socket: socket,
      lastPong: new Date().getTime() / 1000,
    };
  });
});
