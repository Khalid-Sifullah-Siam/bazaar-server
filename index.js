const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
dotenv.config();
const app = express();
const port = process.env.PORT || 5000;


app.use(cors());
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

    const db = client.db("Bazaar");
    const userscollection = db.collection("users");



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