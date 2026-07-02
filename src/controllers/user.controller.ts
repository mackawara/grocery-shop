import { Request, Response } from "express";
import User from "../models/User";

const createOrUpdateUser = async (req: Request, res: Response) => {
  try {
    const { phoneNumber, firstName, lastName, email } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        message: "Phone number is required." 
      });
    }

    const user = await User.findOneAndUpdate(
      { phoneNumber },
      { $set: { firstName, lastName, email } },
      { 
        new: true, 
        upsert: true, 
        runValidators: true 
      }
    );

    return res.status(200).json({
      success: true,
      message: "User synchronized successfully",
      data: user,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getUsers = async (_req: Request, res: Response) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      count: users.length,
      data: users
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getUserByPhone = async (req: Request, res: Response) => {
  try {
    const { phone } = req.params;
    const user = await User.findOne({ phoneNumber: phone });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({ success: true, data: user });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await User.findByIdAndDelete(id);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({ success: true, message: "User deleted successfully" });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const userController = {
  createOrUpdateUser,
  getUsers,
  getUserByPhone,
  deleteUser
};