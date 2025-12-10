// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 4000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

// Multer in-memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 } // 200 MB
});

// ---------- Blob Storage ----------
const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobContainerName = process.env.BLOB_CONTAINER_NAME || "videos";

const blobServiceClient = BlobServiceClient.fromConnectionString(
    storageConnectionString
);
const containerClient = blobServiceClient.getContainerClient(blobContainerName);

async function ensureBlobContainer() {
    await containerClient.createIfNotExists();
}

// ---------- Cosmos DB ----------
const cosmosClient = new CosmosClient({
    endpoint: process.env.COSMOS_ENDPOINT,
    key: process.env.COSMOS_KEY
});

const cosmosDbName = process.env.COSMOS_DB_NAME || "video-db";
const cosmosContainerName = process.env.COSMOS_CONTAINER_NAME || "videos";

const database = cosmosClient.database(cosmosDbName);
const videosContainer = database.container(cosmosContainerName);

// ---------- Helpers ----------
function generateId() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex");
}

// Fetch a single video doc by id using a query (ignores partition key)
async function getVideoById(id) {
    const querySpec = {
        query: "SELECT * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: id }]
    };

    const { resources } = await videosContainer.items.query(querySpec).fetchAll();
    if (!resources || resources.length === 0) return null;
    return resources[0];
}

// ---------- Routes ----------

app.get("/", (req, res) => {
    res.send("Video backend API is running");
});

// LIST all videos
app.get("/api/videos", async (req, res) => {
    try {
        const query = { query: "SELECT * FROM c ORDER BY c.createdAt DESC" };
        const { resources } = await videosContainer.items.query(query).fetchAll();
        res.json(resources);
    } catch (err) {
        console.error("Error listing videos:", err.message);
        res.status(500).json({ error: "Failed to list videos" });
    }
});

// GET single video by id
app.get("/api/videos/:id", async (req, res) => {
    const id = req.params.id;

    try {
        const video = await getVideoById(id);
        if (!video) {
            return res.status(404).json({ error: "Video not found" });
        }

        // Optional view counter
        video.views = (video.views || 0) + 1;
        const partitionKey = video.userId || video.id;

        try {
            await videosContainer.item(video.id, partitionKey).replace(video);
        } catch (e) {
            console.warn("Could not update views:", e.message);
        }

        res.json(video);
    } catch (err) {
        console.error("Error getting video:", err.message);
        res.status(500).json({ error: "Failed to get video" });
    }
});

// LIST videos for one user
app.get("/api/users/:userId/videos", async (req, res) => {
    const userId = req.params.userId;

    try {
        const query = {
            query:
                "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.createdAt DESC",
            parameters: [{ name: "@userId", value: userId }]
        };

        const { resources } = await videosContainer.items.query(query).fetchAll();
        res.json(resources);
    } catch (err) {
        console.error("Error listing user videos:", err.message);
        res.status(500).json({ error: "Failed to list user videos" });
    }
});

// UPLOAD video: Blob + metadata in Cosmos
app.post("/api/videos", upload.single("file"), async (req, res) => {
    try {
        await ensureBlobContainer();

        const { title, description, userId } = req.body;
        const file = req.file;

        if (!title || !userId || !file) {
            return res
                .status(400)
                .json({ error: "title, userId and file are required" });
        }

        const safeName = file.originalname.replace(/\s+/g, "_");
        const blobName = `${Date.now()}-${safeName}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.uploadData(file.buffer, {
            blobHTTPHeaders: { blobContentType: file.mimetype }
        });

        const blobUrl = blockBlobClient.url;
        const id = generateId();

        const newVideo = {
            id,
            title,
            description: description || "",
            userId,
            blobUrl,
            createdAt: new Date().toISOString(),
            views: 0
        };

        await videosContainer.items.create(newVideo);

        res.status(201).json(newVideo);
    } catch (err) {
        console.error("Error uploading video:", err.message);
        res.status(500).json({ error: "Upload failed" });
    }
});

// DELETE video: remove Blob + metadata
app.delete("/api/videos/:id", async (req, res) => {
    const id = req.params.id;

    try {
        const video = await getVideoById(id);
        if (!video) {
            return res.status(404).json({ error: "Video not found" });
        }

        // Delete blob
        if (video.blobUrl) {
            try {
                const blobName = video.blobUrl.split("/").pop();
                const blobClient = containerClient.getBlockBlobClient(blobName);
                await blobClient.deleteIfExists();
            } catch (blobErr) {
                console.warn("Error deleting blob:", blobErr.message);
            }
        }

        // Delete Cosmos doc
        const partitionKey = video.userId || video.id;
        await videosContainer.item(video.id, partitionKey).delete();

        res.json({ status: "deleted" });
    } catch (err) {
        console.error("Error deleting video:", err.message);
        res.status(500).json({ error: "Delete failed" });
    }
});

// ---------- Start ----------
app.listen(port, () => {
    console.log(`Video backend API listening on port ${port}`);
});
