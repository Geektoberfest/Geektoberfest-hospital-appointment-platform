const mongoose = require('mongoose');

// Statuses that occupy a slot. Cancelled appointments release it.
const ACTIVE_STATUSES = ['booked', 'completed'];

const appointmentSchema = new mongoose.Schema(
  {
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department' },
    date: { type: String, required: true }, // YYYY-MM-DD
    startTime: { type: String, required: true }, // HH:MM
    endTime: { type: String, required: true },
    status: { type: String, enum: ['booked', 'completed', 'cancelled'], default: 'booked' },
    reason: { type: String, trim: true, default: '', maxlength: 500 },
    cancellationReason: { type: String, trim: true, default: '', maxlength: 500 },
    review: {
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true, default: '', maxlength: 1000 },
      reviewedAt: { type: Date },
    },
    notes: { type: String, trim: true, default: '', maxlength: 1000 }, // doctor notes
    prescription: { type: String, trim: true, default: '', maxlength: 2000 },
    cancelledBy: { type: String, enum: ['', 'patient', 'doctor', 'admin'], default: '' },
  },
  { timestamps: true }
);

// Database-level guarantee against double booking. Booked and completed
// appointments hold a slot; cancelling frees it for somebody else.
appointmentSchema.index(
  { doctor: 1, date: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } }, name: 'unique_active_doctor_slot' }
);
// A patient cannot be in two places at once.
appointmentSchema.index(
  { patient: 1, date: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } }, name: 'unique_active_patient_slot' }
);
appointmentSchema.index({ patient: 1, date: -1 });
appointmentSchema.index({ doctor: 1, date: -1 });
appointmentSchema.index({ doctor: 1, 'review.rating': 1 });

/** Populate config shared by every controller that returns appointments. */
const populateFields = [
  { path: 'patient', select: 'name email phone' },
  {
    path: 'doctor',
    select: 'user department specialization consultationFee ratingAverage reviewCount',
    populate: [
      { path: 'user', select: 'name email' },
      { path: 'department', select: 'name' },
    ],
  },
  { path: 'department', select: 'name' },
];

const Appointment = mongoose.model('Appointment', appointmentSchema);
Appointment.populateFields = populateFields;
Appointment.ACTIVE_STATUSES = ACTIVE_STATUSES;

module.exports = Appointment;
