const mongoose = require('mongoose');

const doctorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    specialization: { type: String, required: [true, 'Specialization is required'], trim: true },
    qualification: { type: String, trim: true, default: '' },
    experience: { type: Number, min: 0, max: 70, default: 0 }, // years
    consultationFee: { type: Number, min: 0, default: 0 },
    bio: { type: String, trim: true, default: '' },
    ratingAverage: { type: Number, min: 0, max: 5, default: 0 },
    reviewCount: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

doctorSchema.index({ department: 1 });

module.exports = mongoose.model('Doctor', doctorSchema);
