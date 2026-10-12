import { useState } from 'react';
import * as appointmentApi from '../../api/appointmentApi';
import AppointmentList from '../../components/appointments/AppointmentList';
import Alert from '../../components/common/Alert';
import Modal from '../../components/common/Modal';
import PageHeader from '../../components/common/PageHeader';
import Spinner from '../../components/common/Spinner';
import useFetch from '../../hooks/useFetch';
import { doctorName, formatDate, formatTime, getErrorMessage } from '../../utils/format';

const TABS = ['', 'booked', 'completed', 'cancelled'];

const STAR_LABELS = {
  1: 'Poor',
  2: 'Fair',
  3: 'Good',
  4: 'Very Good',
  5: 'Excellent',
};

export default function MyAppointments() {
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });
  const { data, loading, error, reload } = useFetch(() => appointmentApi.getMyAppointments(status ? { status } : {}), [status]);

  // Cancellation modal state
  const [cancellingAppt, setCancellingAppt] = useState(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [isCancelling, setIsCancelling] = useState(false);

  // Review modal state
  const [reviewingAppt, setReviewingAppt] = useState(null);
  const [rating, setRating] = useState(5);
  const [hoveredRating, setHoveredRating] = useState(0);
  const [comment, setComment] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  // Open cancel dialog
  const openCancelModal = (appt) => {
    setCancellingAppt(appt);
    setCancellationReason('');
    setCancelError('');
  };

  const closeCancelModal = () => {
    if (isCancelling) return;
    setCancellingAppt(null);
    setCancellationReason('');
    setCancelError('');
  };

  const handleConfirmCancel = async (e) => {
    e.preventDefault();
    const trimmed = cancellationReason.trim();
    if (!trimmed) {
      setCancelError('Please provide a reason for cancelling this appointment.');
      return;
    }
    if (trimmed.length > 500) {
      setCancelError('Cancellation reason must be 500 characters or fewer.');
      return;
    }

    setIsCancelling(true);
    setCancelError('');
    try {
      await appointmentApi.cancelAppointment(cancellingAppt._id, { cancellationReason: trimmed });
      setMessage({ type: 'success', text: 'Appointment cancelled successfully.' });
      setCancellingAppt(null);
      reload();
    } catch (err) {
      setCancelError(getErrorMessage(err));
    } finally {
      setIsCancelling(false);
    }
  };

  // Open review dialog
  const openReviewModal = (appt) => {
    setReviewingAppt(appt);
    setRating(appt.review?.rating || 5);
    setHoveredRating(0);
    setComment(appt.review?.comment || '');
    setReviewError('');
  };

  const closeReviewModal = () => {
    if (isSubmittingReview) return;
    setReviewingAppt(null);
    setReviewError('');
  };

  const handleReviewSubmit = async (e) => {
    e.preventDefault();
    if (!rating || rating < 1 || rating > 5) {
      setReviewError('Please select a star rating between 1 and 5.');
      return;
    }
    if (comment.length > 1000) {
      setReviewError('Written review must be 1000 characters or fewer.');
      return;
    }

    setIsSubmittingReview(true);
    setReviewError('');
    try {
      await appointmentApi.submitReview(reviewingAppt._id, {
        rating,
        comment: comment.trim(),
      });
      setMessage({ type: 'success', text: 'Thank you! Your rating and review have been submitted.' });
      setReviewingAppt(null);
      reload();
    } catch (err) {
      setReviewError(getErrorMessage(err));
    } finally {
      setIsSubmittingReview(false);
    }
  };

  return (
    <div>
      <PageHeader title="My appointments" />
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t || 'all'}
            type="button"
            onClick={() => setStatus(t)}
            className={`rounded-full border px-4 py-1.5 text-sm capitalize ${
              status === t
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:border-brand-500'
            }`}
          >
            {t || 'all'}
          </button>
        ))}
      </div>
      <div className="mb-4 space-y-2">
        <Alert type={message.type || 'info'}>{message.text}</Alert>
        <Alert>{error}</Alert>
      </div>
      {loading ? (
        <Spinner />
      ) : (
        <AppointmentList
          appointments={data || []}
          role="patient"
          renderActions={(a) => {
            if (a.status === 'booked') {
              return (
                <button
                  type="button"
                  id={`cancel-btn-${a._id}`}
                  className="btn-danger btn-sm"
                  onClick={() => openCancelModal(a)}
                >
                  Cancel
                </button>
              );
            }
            if (a.status === 'completed') {
              if (a.review?.rating) {
                return (
                  <div
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-xs font-medium text-amber-800"
                    title={a.review.comment ? `"${a.review.comment}"` : 'Reviewed'}
                  >
                    <span className="text-amber-500 text-sm">★</span>
                    <span>{a.review.rating}/5 Rated</span>
                  </div>
                );
              }
              return (
                <button
                  type="button"
                  id={`review-btn-${a._id}`}
                  className="btn-primary btn-sm"
                  onClick={() => openReviewModal(a)}
                >
                  Rate &amp; Review
                </button>
              );
            }
            if (a.status === 'cancelled' && a.cancellationReason) {
              return (
                <span
                  className="inline-block max-w-[180px] truncate text-xs text-slate-500"
                  title={`Reason: ${a.cancellationReason}`}
                >
                  Reason: {a.cancellationReason}
                </span>
              );
            }
            return null;
          }}
        />
      )}

      {/* Cancellation Reason Modal */}
      {cancellingAppt && (
        <Modal title="Cancel Appointment" onClose={closeCancelModal}>
          <form onSubmit={handleConfirmCancel} className="space-y-4" noValidate>
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <p>
                <span className="font-medium">Doctor:</span> {doctorName(cancellingAppt.doctor)}
              </p>
              <p>
                <span className="font-medium">Date &amp; Time:</span> {formatDate(cancellingAppt.date)} at{' '}
                {formatTime(cancellingAppt.startTime)}
              </p>
            </div>
            {cancelError && <Alert type="error">{cancelError}</Alert>}
            <div>
              <label htmlFor="cancellation-reason" className="label">
                Cancellation Reason <span className="text-red-500">*</span>
              </label>
              <textarea
                id="cancellation-reason"
                name="cancellationReason"
                rows={3}
                maxLength={500}
                className={`input ${cancelError ? 'input-error' : ''}`}
                value={cancellationReason}
                onChange={(e) => {
                  setCancellationReason(e.target.value);
                  if (cancelError) setCancelError('');
                }}
                placeholder="Please state why you are cancelling this appointment..."
                required
                disabled={isCancelling}
              />
              <div className="mt-1 flex justify-between text-xs text-slate-400">
                <span>Required for patient cancellation</span>
                <span>{500 - cancellationReason.length} characters left</span>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeCancelModal}
                disabled={isCancelling}
              >
                Keep Appointment
              </button>
              <button
                type="submit"
                id="confirm-cancellation-btn"
                className="btn-danger"
                disabled={isCancelling}
              >
                {isCancelling ? 'Cancelling...' : 'Confirm Cancellation'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Rating & Review Modal */}
      {reviewingAppt && (
        <Modal title="Rate & Review Consultation" onClose={closeReviewModal}>
          <form onSubmit={handleReviewSubmit} className="space-y-4" noValidate>
            <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              <p>
                <span className="font-medium">Doctor:</span> {doctorName(reviewingAppt.doctor)}
              </p>
              <p>
                <span className="font-medium">Consultation Date:</span> {formatDate(reviewingAppt.date)}
              </p>
            </div>
            {reviewError && <Alert type="error">{reviewError}</Alert>}
            <div>
              <label className="label">
                Rating <span className="text-red-500">*</span>
              </label>
              <div className="flex items-center gap-2">
                <div className="flex gap-1" role="radiogroup" aria-label="Rating out of 5 stars">
                  {[1, 2, 3, 4, 5].map((star) => {
                    const activeRating = hoveredRating || rating;
                    const isFilled = star <= activeRating;
                    return (
                      <button
                        key={star}
                        type="button"
                        role="radio"
                        aria-checked={rating === star}
                        aria-label={`${star} star${star > 1 ? 's' : ''}`}
                        onClick={() => setRating(star)}
                        onMouseEnter={() => setHoveredRating(star)}
                        onMouseLeave={() => setHoveredRating(0)}
                        disabled={isSubmittingReview}
                        className="text-2xl transition-transform hover:scale-110 focus:outline-none"
                      >
                        <span className={isFilled ? 'text-amber-400' : 'text-slate-300'}>★</span>
                      </button>
                    );
                  })}
                </div>
                <span className="text-sm font-medium text-slate-700">
                  {STAR_LABELS[hoveredRating || rating] || ''}
                </span>
              </div>
            </div>
            <div>
              <label htmlFor="review-comment" className="label">
                Written Review <span className="text-xs text-slate-400">(Optional)</span>
              </label>
              <textarea
                id="review-comment"
                name="reviewComment"
                rows={3}
                maxLength={1000}
                className="input"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Share your experience with the consultation and doctor..."
                disabled={isSubmittingReview}
              />
              <div className="mt-1 text-right text-xs text-slate-400">
                {1000 - comment.length} characters left
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeReviewModal}
                disabled={isSubmittingReview}
              >
                Cancel
              </button>
              <button
                type="submit"
                id="submit-review-btn"
                className="btn-primary"
                disabled={isSubmittingReview || rating < 1 || rating > 5}
              >
                {isSubmittingReview ? 'Submitting...' : 'Submit Review'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
