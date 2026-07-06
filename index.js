const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
dotenv.config({ path: path.join(__dirname, ".env") });
const app = express();
const port = process.env.PORT || 5000;
const upload = multer();
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://localhost:3001",
].filter(Boolean);


app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));
app.use(express.json());



const uri = process.env.MONGODB_URI;


const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const authDb = client.db();
    const db = client.db("Bazaar");
    const authUsersCollection = authDb.collection("user");
    const userscollection = db.collection("users");
    const productsCollection = db.collection("products");
    const buyerPurchasesCollection = db.collection("buyerPurchases");
    const buyerPaymentsCollection = db.collection("buyerPayments");
    const productCategories = ["cloth", "medicine", "book", "fruits", "grocery"];

    await userscollection.updateMany(
      { role: { $exists: false } },
      { $set: { role: "buyer" } }
    );
    await userscollection.updateMany(
      { plan: { $exists: false } },
      { $set: { plan: "free" } }
    );
    const savedUsers = await userscollection.find({}).toArray();
    await Promise.all(
      savedUsers.map((user) =>
        authUsersCollection.updateOne(
          { email: user.email },
          {
            $set: {
              role: user.role || "buyer",
              plan: user.plan || "free",
            },
          }
        )
      )
    );

    app.post("/upload-image", upload.single("image"), async (req, res) => {
      try {
        const file = req.file;
        const apiKey = (
          process.env.IMGBB_API_KEY ||
          process.env.IMGGBB_API_KEY ||
          ""
        ).trim();

        if (!file) {
          return res.status(400).send({ message: "Image is required" });
        }

        if (!apiKey) {
          return res.status(500).send({ message: "IMGBB_API_KEY is missing" });
        }

        const imageForm = new FormData();
        imageForm.append("image", file.buffer.toString("base64"));

        const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
          method: "POST",
          body: imageForm,
        });

        const data = await response.json();

        if (!response.ok || !data?.success) {
          return res.status(500).send({
            message: data?.error?.message || "Image upload failed",
          });
        }

        res.send({ url: data.data.url });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Image upload failed",
        });
      }
    });

    app.post("/users/sync", async (req, res) => {
      try {
        const { authUserId, name, email, image, role } = req.body;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const normalizedRole = ["admin", "seller"].includes(role) ? role : "buyer";
        const now = new Date().toISOString();

        const filter = { email };
        const existingUser = await userscollection.findOne(filter, {
          projection: { role: 1, plan: 1 },
        });

        if (!existingUser) {
          await userscollection.insertOne({
            authUserId: authUserId || null,
            name: name || "",
            email,
            image: image || "",
            role: normalizedRole,
            plan: "free",
            createdAt: now,
            updatedAt: now,
          });

          const savedUser = await userscollection.findOne(filter);
          await authUsersCollection.updateOne(filter, {
            $set: {
              role: savedUser.role,
              plan: savedUser.plan,
            },
          });
          return res.send(savedUser);
        }

        const updateFields = {
          authUserId: authUserId || null,
          name: name || "",
          image: image || "",
          plan: existingUser.plan || "free",
          updatedAt: now,
        };

        if (!existingUser.role) {
          updateFields.role = normalizedRole;
        }

        await userscollection.updateOne(filter, { $set: updateFields });

        const savedUser = await userscollection.findOne(filter);
        await authUsersCollection.updateOne(filter, {
          $set: {
            role: savedUser.role || "buyer",
            plan: savedUser.plan || "free",
          },
        });
        res.send(savedUser);
      } catch (error) {
        res.status(500).send({
          message: error.message || "User profile sync failed",
        });
      }
    });

    app.get("/users/by-email", async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await userscollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        res.status(500).send({
          message: error.message || "User profile fetch failed",
        });
      }
    });

    app.post("/products", async (req, res) => {
      try {
        const { name, category, quantity, price, image, sellerEmail } = req.body;

        if (!name || !category || !quantity || !price || !image || !sellerEmail) {
          return res.status(400).send({ message: "All product fields are required" });
        }

        if (!productCategories.includes(category)) {
          return res.status(400).send({ message: "Invalid product category" });
        }

        const product = {
          name,
          category,
          quantity: Number(quantity),
          price: Number(price),
          image,
          sellerEmail,
          status: "pending",
          soldCount: 0,
          revenue: 0,
          createdAt: new Date().toISOString(),
        };

        if (Number.isNaN(product.quantity) || Number.isNaN(product.price)) {
          return res.status(400).send({ message: "Quantity and price must be numbers" });
        }

        const result = await productsCollection.insertOne(product);
        res.send({ ...product, _id: result.insertedId });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Product save failed",
        });
      }
    });

    app.get("/products", async (req, res) => {
      try {
        const status = req.query.status || "approved";
        const products = await productsCollection
          .find({ status })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(products);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Products fetch failed",
        });
      }
    });

    app.get("/products/seller", async (req, res) => {
      try {
        const sellerEmail = req.query.email;

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        const products = await productsCollection
          .find({ sellerEmail })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(products);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Seller products fetch failed",
        });
      }
    });

    app.get("/products/seller/stats", async (req, res) => {
      try {
        const sellerEmail = req.query.email;

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        const products = await productsCollection
          .find({ sellerEmail })
          .project({ status: 1, soldCount: 1, revenue: 1 })
          .toArray();

        const stats = products.reduce(
          (summary, product) => {
            summary.total += 1;
            summary[product.status] = (summary[product.status] || 0) + 1;
            summary.sold += Number(product.soldCount || 0);
            summary.revenue += Number(product.revenue || 0);
            return summary;
          },
          { total: 0, pending: 0, approved: 0, rejected: 0, sold: 0, revenue: 0 }
        );

        res.send(stats);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Seller stats fetch failed",
        });
      }
    });

    app.get("/buyer/summary", async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        const purchases = await buyerPurchasesCollection.find({ buyerEmail: email }).toArray();
        const payments = await buyerPaymentsCollection.find({ buyerEmail: email }).toArray();

        const summary = purchases.reduce(
          (current, purchase) => {
            current.products += Number(purchase.quantity || 1);
            current.spent += Number(purchase.total || purchase.price || 0);
            return current;
          },
          { products: 0, payments: payments.length, spent: 0 }
        );

        res.send(summary);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Buyer summary fetch failed",
        });
      }
    });

    app.get("/buyer/products", async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        const purchases = await buyerPurchasesCollection
          .find({ buyerEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(purchases);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Buyer products fetch failed",
        });
      }
    });

    app.get("/buyer/payments", async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        const payments = await buyerPaymentsCollection
          .find({ buyerEmail: email })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Buyer payments fetch failed",
        });
      }
    });

    app.get("/admin/overview", async (req, res) => {
      try {
        const totalUsers = await userscollection.countDocuments();
        const requestedProducts = await productsCollection.countDocuments({ status: "pending" });

        res.send({ totalUsers, requestedProducts });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Admin overview fetch failed",
        });
      }
    });

    app.get("/admin/products", async (req, res) => {
      try {
        const products = await productsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.send(products);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Admin products fetch failed",
        });
      }
    });

    app.patch("/admin/products/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        if (!["approved", "rejected", "pending"].includes(status)) {
          return res.status(400).send({ message: "Invalid product status" });
        }

        await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, reviewedAt: new Date().toISOString() } }
        );

        const product = await productsCollection.findOne({ _id: new ObjectId(id) });
        res.send(product);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Product status update failed",
        });
      }
    });

    app.delete("/admin/products/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        const result = await productsCollection.deleteOne({ _id: new ObjectId(id) });

        if (!result.deletedCount) {
          return res.status(404).send({ message: "Product not found" });
        }

        res.send({ deleted: true });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Admin product delete failed",
        });
      }
    });

    app.get("/admin/users", async (req, res) => {
      try {
        const users = await userscollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.send(users);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Admin users fetch failed",
        });
      }
    });

    app.patch("/admin/users/:email", async (req, res) => {
      try {
        const email = decodeURIComponent(req.params.email);
        const { role, accountStatus } = req.body;
        const updateFields = { updatedAt: new Date().toISOString() };

        if (role) {
          if (!["buyer", "seller", "admin"].includes(role)) {
            return res.status(400).send({ message: "Invalid user role" });
          }
          updateFields.role = role;
        }

        if (accountStatus) {
          if (!["active", "blocked", "suspended"].includes(accountStatus)) {
            return res.status(400).send({ message: "Invalid account status" });
          }
          updateFields.accountStatus = accountStatus;
        }

        await userscollection.updateOne(
          { email },
          { $set: updateFields },
          { upsert: false }
        );
        await authUsersCollection.updateOne({ email }, { $set: updateFields });

        const user = await userscollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send(user);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Admin user update failed",
        });
      }
    });

    app.get("/admin/payments", async (req, res) => {
      try {
        const payments = await buyerPaymentsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Admin payments fetch failed",
        });
      }
    });

    app.put("/products/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { name, category, quantity, price, image, sellerEmail } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        if (!name || !category || !quantity || !price || !image || !sellerEmail) {
          return res.status(400).send({ message: "All product fields are required" });
        }

        if (!productCategories.includes(category)) {
          return res.status(400).send({ message: "Invalid product category" });
        }

        const updateFields = {
          name,
          category,
          quantity: Number(quantity),
          price: Number(price),
          image,
          status: "pending",
          updatedAt: new Date().toISOString(),
        };

        if (Number.isNaN(updateFields.quantity) || Number.isNaN(updateFields.price)) {
          return res.status(400).send({ message: "Quantity and price must be numbers" });
        }

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id), sellerEmail },
          { $set: updateFields }
        );

        if (!result.matchedCount) {
          return res.status(404).send({ message: "Product not found" });
        }

        const product = await productsCollection.findOne({ _id: new ObjectId(id) });
        res.send(product);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Product update failed",
        });
      }
    });

    app.delete("/products/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const sellerEmail = req.query.sellerEmail;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        const result = await productsCollection.deleteOne({
          _id: new ObjectId(id),
          sellerEmail,
        });

        if (!result.deletedCount) {
          return res.status(404).send({ message: "Product not found" });
        }

        res.send({ deleted: true });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Product delete failed",
        });
      }
    });


  } finally {


  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Bazaar Server");
});
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
