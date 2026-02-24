<?php

// Using SQLite for free, file-based database
try {
    $conn = new PDO('sqlite:users.db');
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    // Create table if it doesn't exist
    $conn->exec("CREATE TABLE IF NOT EXISTS registered (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )");

} catch(PDOException $e) {
    die("Database connection failed: " . $e->getMessage());
}

?>