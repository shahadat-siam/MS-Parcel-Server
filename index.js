const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const stripe = require("stripe")(process.env.PAYMENT_GETWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

/* ---------- Middleware ---------- */
app.use(cors());
app.use(express.json());

const serviceAccount = require("./firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ot34xl4.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("parcelDB");
    const userCollection = db.collection("users");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    // Middlewere
    const verifyFBToken = async (req, res, next) => {
      // console.log('Heared in Middlewere', req.headers)
      // console.log("fb token hit");
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        console.log("No Auth header");
        return res.status(401).send({ message: "Unauthorized access" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access" });
      }

      // verify token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        // console.log('decodded',decoded)
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden access" });
      }
    };

    // verify Admin Middlewere
    const verifyAdmin = async (req, res, next) => {
      // console.log("verifyAdmin hit");
      const email = req.decoded.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      // console.log(email);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await userCollection.findOne({ email });
      if (userExists) {
        return res
          .status(200)
          .send({ message: "User Already exists", inserted: false });
      }
      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.post("/rider", verifyFBToken, async (req, res) => {
      const rider = req.body;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // 🔍 Get user for role update (Partial Email Search)
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { email } = req.query;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        // 🔥 Partial + case-insensitive search
        const query = {
          email: { $regex: email, $options: "i" },
        };

        const users = await userCollection
          .find(query)
          .project({ email: 1, role: 1, create_at: 1, last_login: 1 })
          .limit(10) // prevent loading too many users
          .toArray();

        if (users.length === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(users); // ✅ send array directly (not [users])
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // 🛡️ Make/Remove admin (Single Role Update Route)
    app.patch(
      "/users/role/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const { role } = req.body;

          // Only allow 'admin' or 'user'
          if (!["admin", "user"].includes(role)) {
            return res.status(400).send({ message: "Invalid role" });
          }

          // Optional but Recommended: Prevent self demotion
          const targetUser = await userCollection.findOne({
            _id: new ObjectId(id),
          });

          if (!targetUser) {
            return res.status(404).send({ message: "User not found" });
          }

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } },
          );

          res.send({
            message: `Role updated to ${role}`,
            modifiedCount: result.modifiedCount,
          });
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Server error" });
        }
      },
    );

    // users role route
    app.get("/users/:email/role", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;
        // console.log('from params',email)
        // safety check
        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }
        // Optional Security: ensure user can only access their own role
        // if (req.decoded?.email !== email) {
        //   return res.status(403).send({ message: "Forbidden access" });
        // }
        const user = await userCollection.findOne(
          { email: email },
          { projection: { role: 1, email: 1 } },
        );
        // if user not found → default role "user"
        if (!user) {
          return res.send({ role: "user" });
        }

        res.send({ role: user.role || "user" });
      } catch (error) {
        console.error("Error getting user role:", error);
        res.status(500).send({ message: "Failed to get user role" });
      }
    });

    // get all riders by each status
    app.get("/riders", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { status } = req.query;

        let query = {};

        if (status) {
          query.status = status;
        }

        const riders = await ridersCollection.find(query).toArray();

        res.send(riders);
      } catch (error) {
        console.log("Failed to get riders", error);
        res.status(500).send({ message: "Failed to get riders" });
      }
    });

    app.patch(
      "/riders/status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        // console.log("ID from rider status", id);
        const { status, email } = req.body;
        const query = { _id: new ObjectId(id) };
        const updateDoc = { $set: { status } };

        const result = await ridersCollection.updateOne(query, updateDoc);

        if (status === "approved") {
          const userQuery = { email };
          const userUpdateDoc = {
            $set: {
              role: "rider",
            },
          };
          const roleResult = await userCollection.updateOne(
            userQuery,
            userUpdateDoc,
          );
          res.send(roleResult);
        }

        res.send(result);
      },
    );

    // app.get("/parcels", verifyFBToken, async (req, res) => {
    //   const parcels = await parcelCollection.find().toArray();
    //   res.send(parcels);
    // });

    // get my parcels by email
    app.get("/parcel", verifyFBToken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;
        let query = {};
        if (email) {
          query = { create_by: email };
        }
        if (payment_status) {
          query.payment_status = payment_status;
        }
        if (delivery_status) {
          query.delivery_status = delivery_status;
        }
        const options = {
          sort: { creation_date: -1 }, // newest first
        };

        const parcels = await parcelCollection.find(query, options).toArray(); // ✅ fixed
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching Parcels:", error);
        res.status(500).send({ message: "Failed to get parcels" });
      }
    });

    // get a parcel info by id
    app.get("/parcels/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        // console.log('ID', id)
        const parcel = await parcelCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({ message: "Parcel Not Found" });
        }
        res.send(parcel);
      } catch (error) {
        console.log("Error featching parcel", error);
        res.status(500).send({ message: "Failed to fatching parcel" });
      }
    });

    // payment intent
    app.post("/create-payment-intent", verifyFBToken, async (req, res) => {
      const paymentInCents = req.body.paymentInCents;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: paymentInCents, // amount in cents
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // get payment record
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const userEmail = req.query.email;
        // console.log(userEmail)
        if (req.decoded.email !== userEmail) {
          return res.status(403).send({ message: "Forbidden access" });
        }
        const query = userEmail ? { email: userEmail } : {};
        const options = { sort: { paid_at: -1 } };

        const payment = await paymentCollection.find(query, options).toArray();
        res.send(payment);
      } catch (error) {
        console.log("error fatching payment history", error);
        res.status(500).send({ message: "Failed to get payment" });
      }
    });

    app.post("/payment", verifyFBToken, async (req, res) => {
      try {
        const { id, email, amount, paymentMethod, transactionId } = req.body;

        // update parcel payment status
        const updateResult = await parcelCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { payment_status: "paid" } },
        );
        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid " });
        }

        // insert payment record
        const paymentDoc = {
          id,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };
        const paymentResult = await paymentCollection.insertOne(paymentDoc);
        res.status(201).send({
          message: "Payment recorded & parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment process failed", error.message);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    // post a parcel route
    app.post("/parcels", verifyFBToken, async (req, res) => {
      const parcel = req.body;
      const result = await parcelCollection.insertOne(parcel);
      res.status(201).send(result);
    });

    // delete parcel
    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;

      try {
        const result = await parcelCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send({
          success: true,
          message: "Parcel deleted successfully",
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        res.status(500).send({
          success: false,
          message: "Failed to delete parcel",
        });
      }
    });

    // GET /availableriders?district=Dhaka
    app.get("/availableriders", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const { district } = req.query;
        // console.log("Fetching riders for district:", district); 
        const query = {
          status: "approved", // only approved riders
        };

        if (district) {
          query.district = district; // match sender_center district
        }

        const riders = await ridersCollection
          .find(query, {
            projection: {
              name: 1,
              email: 1,
              district: 1,
              region: 1,
              phone: 1,
            },
          })
          .toArray(); 
        // console.log("Query:", query);
        // console.log("Found riders:", riders.length); 
        res.send(riders);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to get riders" });
      }
    });

    // PATCH /parcels/assign-rider/:id
    app.patch("/parcels/assign-rider/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { riderId, rider_name, rider_email, rider_phone, delivery_status } = req.body;

      const updateDoc = {
        $set: {
          riderId, rider_name, rider_email, rider_phone, delivery_status,
          assigned_at: new Date(),
        },
      };

      const result = await parcelCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc,
      );

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

/* ---------- Test Route ---------- */
app.get("/", (req, res) => {
  res.send("🚚 Parcel Server is Running!");
});

/* ----------  API Route ---------- */

/* ---------- Start Server ---------- */
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
