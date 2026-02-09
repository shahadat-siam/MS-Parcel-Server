const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());

/* ---------- Test Route ---------- */
app.get("/", (req, res) => {
  res.send("🚚 Parcel Server is Running!");
});

/* ----------  API Route ---------- */
 

/* ---------- Start Server ---------- */
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
