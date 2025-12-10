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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// File upload
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
});

// Azure Blob Storage
const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobContainerName = process.env.BLOB_CONTAINER_NAME || "videos";
const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
const containerClient = blobServiceClient.getContainerClient(blobContainerName);

async function ensureBlobContainer() {
    try {
        await containerClient.createIfNotExists();
        console.log(`Blob container '${blobContainerName}' is ready`);
    } catch (err) {
        console.error("Error ensuring blob container:", err.message);
    }
}

// Cosmos DB Setup
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
const cosmosDbName = process.env.COSMOS_DB_NAME || "video-db";
const cosmosContainerName = process.env.COSMOS_CONTAINER_NAME || "videos";
const cosmosClient = new CosmosClient({ endpoint: cosmosEndpoint, key: cosmosKey });

const database = cosmosClient.database(cosmosDbName);
const videosContainer = database.container(cosmosContainerName);
const usersContainer = database.container("users"); // New container for user data

// Helper functions
function generateId() {
    return crypto.randomUUID();
}

async function getUserById(id) {
    try {
        const { resources } = await usersContainer.items
            .query("SELECT * FROM c WHERE c.id = @id", {
                parameters: [{ name: "@id", value: id }],
            })
            .fetchAll();
        return resources[0];
    } catch (err) {
        console.error("Error getting user:", err.message);
        return null;
    }
}

async function createUser(user) {
    try {
        await usersContainer.items.create(user);
    } catch (err) {
        console.error("Error creating user:", err.message);
    }
}

// Routes
app.get("/", (req, res) => {
    res.send("Video backend API is running");
});

// Get authenticated user data
app.get("/api/auth/me", async (req, res) => {
    try {
        const user = await fetchAuthUser(req);
        res.json(user);
    } catch (err) {
        console.error("Error fetching user data:", err.message);
        res.status(500).json({ error: "Failed to fetch user data" });
    }
});

// Fetch user from Azure's EasyAuth
async function fetchAuthUser(req) {
    const { data } = await fetch("/.auth/me", { credentials: "include" });
    if (!Array.isArray(data) || data.length === 0) throw new Error("No user found");
    const principal = data[0];
    const userId = principal.user_id || principal.userDetails;

    let user = await getUserById(userId);
    if (!user) {
        user = {
            id: userId,
            username: principal.userDetails,
            displayName: principal.userDetails,
            email: principal.email || "",
        };
        await createUser(user);
    }

    return user;
}

// Get all videos
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

// Upload a new video
app.post("/api/videos", upload.single("file"), async (req, res) => {
    try {
        await ensureBlobContainer();

        const { title, description, userId } = req.body;
        const file = req.file;

        if (!title || !userId || !file) {
            return res.status(400).json({ error: "title, userId, and file are required" });
        }

        const blobName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.uploadData(file.buffer, {
            blobHTTPHeaders: { blobContentType: file.mimetype },
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
            views: 0,
        };

        await videosContainer.items.create(newVideo);

        res.status(201).json(newVideo);
    } catch (err) {
        console.error("Error uploading video:", err.message);
        res.status(500).json({ error: "Upload failed" });
    }
});

// Get videos by userId
app.get("/api/users/:userId/videos", async (req, res) => {
    const userId = req.params.userId;

    try {
        const query = {
            query: "SELECT * FROM c WHERE c.userId = @userId ORDER BY c.createdAt DESC",
            parameters: [{ name: "@userId", value: userId }],
        };
        const { resources } = await videosContainer.items.query(query).fetchAll();
        res.json(resources);
    } catch (err) {
        console.error("Error listing user videos:", err.message);
        res.status(500).json({ error: "Failed to list user videos" });
    }
});

// Video delete endpoint
app.delete("/api/videos/:id", async (req, res) => {
    const id = req.params.id;

    try {
        const { resource: video } = await videosContainer.item(id, id).read();
        if (!video) {
            return res.status(404).json({ error: "Video not found" });
        }

        const blobName = video.blobUrl.split("/").pop();
        const blobClient = containerClient.getBlockBlobClient(blobName);
        await blobClient.deleteIfExists();

        await videosContainer.item(id, id).delete();

        res.json({ status: "deleted" });
    } catch (err) {
        console.error("Error deleting video:", err.message);
        res.status(500).json({ error: "Delete failed" });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Video backend API listening on port ${port}`);
});
