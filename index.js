const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const Stripe = require("stripe");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId, ServerApiVersion } = require("mongodb");
dotenv.config({ path: path.join(__dirname, ".env") });
const app = express();
const port = process.env.PORT || 5000;
const upload = multer();
const stripeSecretKey =
  process.env.STRIPE_SECRET_KEY ||
  process.env["NEXT_PUBLIC_+STRIPE_SECRET_KEY"] ||
  "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const jwtSecret = process.env.JWT_SECRET || process.env.BETTER_AUTH_SECRET || "bazaar-dev-jwt-secret";
const sellerPlans = {
  pro: {
    name: "Pro",
    price: 4,
    features: "More visibility, priority review, seller insights",
  },
  max: {
    name: "Max",
    price: 14,
    features: "Highest visibility, fastest review, advanced sales tracking",
  },
};
const normalizeOrigin = (url) => (url || "").replace(/\/$/, "");
const allowedOrigins = [
  ...String(process.env.CLIENT_URL || "")
    .split(",")
    .map((url) => normalizeOrigin(url.trim())),
  "http://localhost:3000",
  "http://localhost:3001",
].filter(Boolean);

const isAllowedOrigin = (origin) => {
  const normalizedOrigin = normalizeOrigin(origin);

  return (
    allowedOrigins.includes(normalizedOrigin) ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalizedOrigin)
  );
};

app.use(cors({
  origin(origin, callback) {
    if (!origin || isAllowedOrigin(origin)) {
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

    const createToken = (user) =>
      jwt.sign(
        {
          email: user.email,
          role: user.role || "buyer",
          plan: user.plan || "free",
        },
        jwtSecret,
        { expiresIn: "7d" }
      );

    const verifyToken = async (req, res, next) => {
      try {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : "";

        if (!token) {
          return res.status(401).send({ message: "Unauthorized request" });
        }

        const decoded = jwt.verify(token, jwtSecret);
        const user = await userscollection.findOne({ email: decoded.email });

        if (!user) {
          return res.status(401).send({ message: "User not found" });
        }

        req.user = {
          email: user.email,
          role: user.role || "buyer",
          plan: user.plan || "free",
        };
        next();
      } catch {
        res.status(401).send({ message: "Invalid or expired token" });
      }
    };

    const requireRole = (...roles) => (req, res, next) => {
      if (!roles.includes(req.user?.role)) {
        return res.status(403).send({ message: "Forbidden route" });
      }

      next();
    };

    const requireSameEmail = (req, res, email) => {
      if (req.user.role !== "admin" && req.user.email !== email) {
        res.status(403).send({ message: "Forbidden user access" });
        return false;
      }

      return true;
    };

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

    app.post("/auth/jwt", async (req, res) => {
      try {
        const { email, authUserId } = req.body;

        if (!email || !authUserId) {
          return res.status(400).send({ message: "Email and auth user id are required" });
        }

        let user = await userscollection.findOne({ email });

        if (!user) {
          return res.status(401).send({ message: "Invalid auth user" });
        }

        if (!user.authUserId || user.authUserId !== authUserId) {
          await userscollection.updateOne(
            { email },
            { $set: { authUserId, updatedAt: new Date().toISOString() } }
          );
          user = { ...user, authUserId };
        }

        res.send({ token: createToken(user) });
      } catch (error) {
        res.status(500).send({
          message: error.message || "JWT create failed",
        });
      }
    });

    app.post("/products", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const { name, category, quantity, price, image, sellerEmail } = req.body;

        if (!name || !category || !quantity || !price || !image || !sellerEmail) {
          return res.status(400).send({ message: "All product fields are required" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
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

    app.get("/products/seller", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const sellerEmail = req.query.email;

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
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

    app.get("/products/seller/stats", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const sellerEmail = req.query.email;

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
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

    app.get("/products/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        const product = await productsCollection.findOne({
          _id: new ObjectId(id),
          status: "approved",
        });

        if (!product) {
          return res.status(404).send({ message: "Product not found" });
        }

        res.send(product);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Product fetch failed",
        });
      }
    });

    app.get("/buyer/summary", verifyToken, requireRole("buyer"), async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        if (req.user.email !== email) {
          return res.status(403).send({ message: "Forbidden buyer access" });
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

    app.get("/buyer/products", verifyToken, requireRole("buyer"), async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        if (req.user.email !== email) {
          return res.status(403).send({ message: "Forbidden buyer access" });
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

    app.post("/checkout/sessions", verifyToken, requireRole("buyer"), async (req, res) => {
      try {
        const { productId, buyerEmail, quantity } = req.body;
        const selectedQuantity = Number(quantity);

        if (!stripe) {
          return res.status(500).send({ message: "Stripe secret key is missing" });
        }

        if (!ObjectId.isValid(productId)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        if (!buyerEmail) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        if (req.user.email !== buyerEmail) {
          return res.status(403).send({ message: "Forbidden buyer access" });
        }

        if (!Number.isInteger(selectedQuantity) || selectedQuantity < 1) {
          return res.status(400).send({ message: "Quantity must be at least 1" });
        }

        const productObjectId = new ObjectId(productId);
        const product = await productsCollection.findOne({
          _id: productObjectId,
          status: "approved",
        });

        if (!product) {
          return res.status(404).send({ message: "Product not found" });
        }

        if (Number(product.quantity || 0) < selectedQuantity) {
          return res.status(400).send({
            message: `Only ${product.quantity || 0} item${product.quantity === 1 ? "" : "s"} available`,
          });
        }

        const total = Number(product.price || 0) * selectedQuantity;
        const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer_email: buyerEmail,
          line_items: [
            {
              quantity: selectedQuantity,
              price_data: {
                currency: "usd",
                unit_amount: Math.round(Number(product.price || 0) * 100),
                product_data: {
                  name: product.name,
                  images: product.image ? [product.image] : [],
                },
              },
            },
          ],
          metadata: {
            productId,
            buyerEmail,
            quantity: String(selectedQuantity),
            total: String(total),
          },
          success_url: `${clientUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${clientUrl}/checkout/cancel`,
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Checkout failed",
        });
      }
    });

    app.post("/checkout/sessions/:sessionId/confirm", verifyToken, requireRole("buyer"), async (req, res) => {
      try {
        const { sessionId } = req.params;

        if (!stripe) {
          return res.status(500).send({ message: "Stripe secret key is missing" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ message: "Payment is not completed" });
        }

        const existingPayment = await buyerPaymentsCollection.findOne({
          stripeSessionId: session.id,
        });

        if (existingPayment) {
          return res.send({ message: "Payment already confirmed" });
        }

        const productId = session.metadata?.productId;
        const buyerEmail = session.metadata?.buyerEmail;
        const selectedQuantity = Number(session.metadata?.quantity || 0);

        if (req.user.email !== buyerEmail) {
          return res.status(403).send({ message: "Forbidden buyer access" });
        }

        if (!ObjectId.isValid(productId) || !buyerEmail || selectedQuantity < 1) {
          return res.status(400).send({ message: "Invalid checkout metadata" });
        }

        const productObjectId = new ObjectId(productId);
        const product = await productsCollection.findOne({
          _id: productObjectId,
          status: "approved",
        });

        if (!product) {
          return res.status(404).send({ message: "Product not found" });
        }

        const total = Number(product.price || 0) * selectedQuantity;
        const now = new Date().toISOString();
        const stockUpdate = await productsCollection.updateOne(
          {
            _id: productObjectId,
            status: "approved",
            quantity: { $gte: selectedQuantity },
          },
          {
            $inc: {
              quantity: -selectedQuantity,
              soldCount: selectedQuantity,
              revenue: total,
            },
            $set: { updatedAt: now },
          }
        );

        if (!stockUpdate.modifiedCount) {
          return res.status(400).send({ message: "Not enough stock available" });
        }

        const purchase = {
          productId,
          name: product.name,
          category: product.category,
          image: product.image,
          price: Number(product.price || 0),
          quantity: selectedQuantity,
          total,
          buyerEmail,
          sellerEmail: product.sellerEmail,
          stripeSessionId: session.id,
          createdAt: now,
        };
        const payment = {
          productId,
          productName: product.name,
          buyerEmail,
          sellerEmail: product.sellerEmail,
          amount: total,
          quantity: selectedQuantity,
          status: "paid",
          stripeSessionId: session.id,
          createdAt: now,
        };

        const purchaseResult = await buyerPurchasesCollection.insertOne(purchase);
        await buyerPaymentsCollection.insertOne(payment);

        res.send({ ...purchase, _id: purchaseResult.insertedId });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Payment confirmation failed",
        });
      }
    });

    app.post("/seller-plans/checkout", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const { sellerEmail, plan } = req.body;
        const selectedPlan = sellerPlans[plan];

        if (!stripe) {
          return res.status(500).send({ message: "Stripe secret key is missing" });
        }

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
        }

        if (!selectedPlan) {
          return res.status(400).send({ message: "Invalid seller plan" });
        }

        const seller = await userscollection.findOne({ email: sellerEmail });

        if (!seller || seller.role !== "seller") {
          return res.status(403).send({ message: "Only sellers can upgrade plans" });
        }

        const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          customer_email: sellerEmail,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: selectedPlan.price * 100,
                product_data: {
                  name: `${selectedPlan.name} Seller Plan`,
                  description: selectedPlan.features,
                },
              },
            },
          ],
          metadata: {
            type: "seller-plan",
            sellerEmail,
            plan,
          },
          success_url: `${clientUrl}/plans/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${clientUrl}/plans/cancel`,
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Plan checkout failed",
        });
      }
    });

    app.post("/seller-plans/checkout/:sessionId/confirm", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const { sessionId } = req.params;

        if (!stripe) {
          return res.status(500).send({ message: "Stripe secret key is missing" });
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ message: "Payment is not completed" });
        }

        if (session.metadata?.type !== "seller-plan") {
          return res.status(400).send({ message: "Invalid plan checkout session" });
        }

        const sellerEmail = session.metadata?.sellerEmail;
        const plan = session.metadata?.plan;
        const selectedPlan = sellerPlans[plan];

        if (!sellerEmail || !selectedPlan) {
          return res.status(400).send({ message: "Invalid plan checkout metadata" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
        }

        const existingPayment = await buyerPaymentsCollection.findOne({
          stripeSessionId: session.id,
        });

        if (existingPayment) {
          return res.send({ message: "Plan already confirmed", plan });
        }

        const updateFields = {
          plan,
          planPrice: selectedPlan.price,
          planUpdatedAt: new Date().toISOString(),
        };

        const result = await userscollection.updateOne(
          { email: sellerEmail, role: "seller" },
          { $set: updateFields }
        );

        if (!result.matchedCount) {
          return res.status(404).send({ message: "Seller not found" });
        }

        await authUsersCollection.updateOne(
          { email: sellerEmail },
          { $set: updateFields }
        );

        await buyerPaymentsCollection.insertOne({
          productName: `${selectedPlan.name} Seller Plan`,
          sellerEmail,
          buyerEmail: sellerEmail,
          amount: selectedPlan.price,
          status: "paid",
          type: "seller-plan",
          plan,
          stripeSessionId: session.id,
          createdAt: updateFields.planUpdatedAt,
        });

        res.send({ message: "Plan updated", plan });
      } catch (error) {
        res.status(500).send({
          message: error.message || "Plan confirmation failed",
        });
      }
    });

    app.get("/seller-plans/history", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        if (req.user.email !== email) {
          return res.status(403).send({ message: "Forbidden seller access" });
        }

        const history = await buyerPaymentsCollection
          .find({ sellerEmail: email, type: "seller-plan" })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(history);
      } catch (error) {
        res.status(500).send({
          message: error.message || "Plan history fetch failed",
        });
      }
    });

    app.get("/buyer/payments", verifyToken, requireRole("buyer"), async (req, res) => {
      try {
        const email = req.query.email;

        if (!email) {
          return res.status(400).send({ message: "Buyer email is required" });
        }

        if (req.user.email !== email) {
          return res.status(403).send({ message: "Forbidden buyer access" });
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

    app.get("/admin/overview", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.get("/admin/products", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.patch("/admin/products/:id/status", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.delete("/admin/products/:id", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.get("/admin/users", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.patch("/admin/users/:email", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.get("/admin/payments", verifyToken, requireRole("admin"), async (req, res) => {
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

    app.put("/products/:id", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const { id } = req.params;
        const { name, category, quantity, price, image, sellerEmail } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        if (!name || !category || !quantity || !price || !image || !sellerEmail) {
          return res.status(400).send({ message: "All product fields are required" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
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

    app.delete("/products/:id", verifyToken, requireRole("seller"), async (req, res) => {
      try {
        const { id } = req.params;
        const sellerEmail = req.query.sellerEmail;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product id" });
        }

        if (!sellerEmail) {
          return res.status(400).send({ message: "Seller email is required" });
        }

        if (req.user.email !== sellerEmail) {
          return res.status(403).send({ message: "Forbidden seller access" });
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
const ready = run().catch((error) => {
  console.error(error);
  throw error;
});

app.get("/", (req, res) => {
  res.send("Bazaar Server");
});

if (require.main === module) {
  ready.then(() => {
    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  });
}

module.exports = async (req, res) => {
  await ready;
  return app(req, res);
};
