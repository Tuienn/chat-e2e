import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const { DB_USER, DB_PASSWORD, DB_HOST, DB_NAME } = process.env;
    const uri = `mongodb+srv://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/${DB_NAME}?retryWrites=true&w=majority`;

    await mongoose.connect(uri);
    console.log("✅ MongoDB connected successfully");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error.message);
    process.exit(1);
  }
};

export default connectDB;
