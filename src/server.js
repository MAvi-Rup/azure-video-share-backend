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
app.use(cors());               // allow frontend to call this API
app.use(express.json());       // parse JSON bodies

// Multer in-memory storage for uploaded files
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50 MB max
});

// ---------- Blob Storage Setup ----------
const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const blobContainerName = process.env.BLOB_CONTAINER_NAME || "videos";

if (!storageConnectionString) {
    console.warn("WARNING: AZURE_STORAGE_CONNECTION_STRING is not set");
}

const blobServiceClient = BlobServiceClient.fromConnectionString(
    storageConnectionString
);
const containerClient = blobServiceClient.getContainerClient(blobContainerName);

async function ensureBlobContainer() {
    try {
        await containerClient.createIfNotExists();
        console.log(`Blob container '${blobContainerName}' is ready`);
    } catch (err) {
        console.error("Error ensuring blob container:", err.message);
    }
}

// ---------- Cosmos DB Setup ----------
// const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
// const cosmosKey = process.env.COSMOS_KEY;
// const cosmosDbName = process.env.COSMOS_DB_NAME || "video-db";
// const cosmosContainerName = process.env.COSMOS_CONTAINER_NAME || "videos";


// ---------- Cosmos DB Setup ----------
const cosmosEndpoint = process.env.COSMOS_ENDPOINT;
const cosmosKey = process.env.COSMOS_KEY;
const cosmosDbName = process.env.COSMOS_DB_NAME || "video-db";
const cosmosContainerName = process.env.COSMOS_CONTAINER_NAME || "videos";
// NEW: separate container for comments
const cosmosCommentsContainerName =
    process.env.COSMOS_COMMENTS_CONTAINER_NAME || "comments";


if (!cosmosEndpoint || !cosmosKey) {
    console.warn("WARNING: COSMOS_ENDPOINT or COSMOS_KEY not set");
}

const cosmosClient = new CosmosClient({
    endpoint: cosmosEndpoint,
    key: cosmosKey
});

// const database = cosmosClient.database(cosmosDbName);
// const videosContainer = database.container(cosmosContainerName);

const database = cosmosClient.database(cosmosDbName);
const videosContainer = database.container(cosmosContainerName);
const commentsContainer = database.container(cosmosCommentsContainerName); // NEW


// ---------- Helper functions ----------

// Generate a unique ID for Cosmos documents
function generateId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString("hex");
}

function generateId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return crypto.randomBytes(16).toString("hex");
}


// ---------- Routes ----------

// Simple health check
app.get("/", (req, res) => {
    res.send("Video backend API is running");
});

// GET /api/videos  → list all videos (latest first)
app.get("/api/videos", async (req, res) => {
    try {
        const query = {
            query: "SELECT * FROM c ORDER BY c.createdAt DESC"
        };

        const { resources } = await videosContainer.items.query(query).fetchAll();
        res.json(resources);
    } catch (err) {
        console.error("Error listing videos:", err.message);
        res.status(500).json({ error: "Failed to list videos" });
    }
});

//route for comments 
// ---------- Comment routes ----------

// GET /api/videos/:videoId/comments → list comments for a video
app.get("/api/videos/:videoId/comments", async (req, res) => {
    const videoId = req.params.videoId;

    try {
        const query = {
            query:
                "SELECT * FROM c WHERE c.videoId = @videoId ORDER BY c.createdAt ASC",
            parameters: [{ name: "@videoId", value: videoId }]
        };

        const { resources } = await commentsContainer.items.query(query).fetchAll();
        res.json(resources);
    } catch (err) {
        console.error("Error listing comments:", err.message);
        res.status(500).json({ error: "Failed to list comments" });
    }
});

// POST /api/videos/:videoId/comments → add a new comment
app.post("/api/videos/:videoId/comments", async (req, res) => {
    const videoId = req.params.videoId;
    const { userId, userName, text } = req.body;

    if (!userId || !text) {
        return res
            .status(400)
            .json({ error: "userId and text are required for comments" });
    }

    try {
        const id = generateId();
        const newComment = {
            id,
            videoId,
            userId,
            userName: userName || userId,
            text,
            createdAt: new Date().toISOString()
        };

        await commentsContainer.items.create(newComment);
        res.status(201).json(newComment);
    } catch (err) {
        console.error("Error creating comment:", err.message);
        res.status(500).json({ error: "Failed to create comment" });
    }
});

// DELETE /api/videos/:videoId/comments/:commentId → delete own comment
app.delete(
    "/api/videos/:videoId/comments/:commentId",
    async (req, res) => {
        const videoId = req.params.videoId;
        const commentId = req.params.commentId;

        // We trust the frontend to send x-user-id from the logged-in user
        const currentUserId = req.headers["x-user-id"];

        if (!currentUserId) {
            return res.status(401).json({
                error: "Missing x-user-id header"
            });
        }

        try {
            const { resource: comment } = await commentsContainer
                .item(commentId, commentId) // partition key = /id
                .read();

            if (!comment || comment.videoId !== videoId) {
                return res.status(404).json({ error: "Comment not found" });
            }

            if (comment.userId !== currentUserId) {
                return res
                    .status(403)
                    .json({ error: "You can only delete your own comment" });
            }

            await commentsContainer.item(commentId, commentId).delete();
            res.json({ status: "deleted" });
        } catch (err) {
            console.error("Error deleting comment:", err.message);
            res.status(500).json({ error: "Failed to delete comment" });
        }
    }
);


// GET /api/videos/:id → get a single video by id
app.get("/api/videos/:id", async (req, res) => {
    const id = req.params.id;

    try {
        const { resource } = await videosContainer.item(id, id).read();
        if (!resource) {
            return res.status(404).json({ error: "Video not found" });
        }
        res.json(resource);
    } catch (err) {
        console.error("Error getting video:", err.message);
        res.status(404).json({ error: "Video not found" });
    }
});

// POST /api/videos → upload a new video
app.post("/api/videos", upload.single("file"), async (req, res) => {
    try {
        await ensureBlobContainer();

        const { title, description, userId } = req.body;
        const file = req.file;

        if (!title || !userId || !file) {
            return res.status(400).json({ error: "title, userId and file are required" });
        }

        // Upload file to Blob Storage
        const blobName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
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

        // Save metadata in Cosmos DB
        await videosContainer.items.create(newVideo);

        res.status(201).json(newVideo);
    } catch (err) {
        console.error("Error uploading video:", err.message);
        res.status(500).json({ error: "Upload failed" });
    }
});

// DELETE /api/videos/:id → delete video + blob
// DELETE /api/videos/:id → delete video + blob + its comments
app.delete("/api/videos/:id", async (req, res) => {
    const id = req.params.id;

    try {
        // Read the document first to get blob URL
        const { resource: video } = await videosContainer.item(id, id).read();
        if (!video) {
            return res.status(404).json({ error: "Video not found" });
        }

        // Delete the blob
        try {
            const blobName = video.blobUrl.split("/").pop();
            const blobClient = containerClient.getBlockBlobClient(blobName);
            await blobClient.deleteIfExists();
        } catch (blobErr) {
            console.warn("Warning: error deleting blob:", blobErr.message);
        }

        // Delete all comments for this video
        try {
            const query = {
                query: "SELECT * FROM c WHERE c.videoId = @videoId",
                parameters: [{ name: "@videoId", value: id }]
            };

            const { resources: comments } = await commentsContainer.items
                .query(query)
                .fetchAll();

            for (const comment of comments) {
                await commentsContainer.item(comment.id, comment.id).delete();
            }
        } catch (commentsErr) {
            console.warn(
                "Warning: error deleting comments for video:",
                commentsErr.message
            );
        }

        // Delete the document from Cosmos
        await videosContainer.item(id, id).delete();

        res.json({ status: "deleted" });
    } catch (err) {
        console.error("Error deleting video:", err.message);
        res.status(500).json({ error: "Delete failed" });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Video backend API listening on port ${port}`);
});