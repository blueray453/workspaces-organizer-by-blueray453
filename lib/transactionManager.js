// Centralized transaction manager for atomic cross‑workspace moves.
// - During a transaction, UI updates are deferred (only marked dirty).
// - On commit, all dirty thumbnails rebuild once.
// - Outside transactions, changes update UI immediately.

const _dirtyThumbnails = new Set();
const _transactedWindows = new Map(); // window -> { targetStore, insertIndex }
const _animationWindows = new Map(); // thumbnail -> window to animate
let _active = false;

export const TransactionManager = {
    beginTransaction(window, targetStore, insertIndex) {
        _active = true;
        _transactedWindows.set(window, { targetStore, insertIndex });
    },

    isActive() {
        return _active;
    },

    isWindowBeingTransacted(window) {
        return _transactedWindows.has(window);
    },

    getTransactionData(window) {
        return _transactedWindows.get(window);
    },

    markDirty(thumbnail) {
        _dirtyThumbnails.add(thumbnail);
    },

    setAnimatedWindow(thumbnail, window) {
        _animationWindows.set(thumbnail, window);
    },

    commitTransaction() {
        for (const thumb of _dirtyThumbnails) {
            const animatedWindow = _animationWindows.get(thumb);
            if (thumb._displayMode && typeof thumb._displayMode.render === 'function') {
                thumb._displayMode.render({ animatedWindow });
            }
        }
        _dirtyThumbnails.clear();
        _transactedWindows.clear();
        _animationWindows.clear();
        _active = false;
    },

    abortTransaction() {
        _dirtyThumbnails.clear();
        _transactedWindows.clear();
        _animationWindows.clear();
        _active = false;
    }
};