/**
 * CIPRMS Shared Reusable Drag-and-Drop Uploader Helper
 * Provides consistent, accessible, responsive drag-and-drop file selection across CIPRMS.
 *
 * Supported workflows:
 *   1. Monitoring → Add New Partnership (OCR Auto-fill)
 *   2. Requests → Partnership Requests → Submission (OCR Auto-fill & attachment)
 *   3. Requests → Partnership Requests → Review → View Draft (Timeline version upload)
 *   4. Requests → Document Requests → Review → View Draft (Timeline version upload)
 *   5. Document Library → Upload & Extract (OCR extraction + Duplicate detection)
 */

(function (window) {
  'use strict';

  // Prevent browser from opening files dropped anywhere outside intentional drop zones
  window.addEventListener('dragover', function (e) {
    e.preventDefault();
  }, false);
  window.addEventListener('drop', function (e) {
    e.preventDefault();
  }, false);

  const DEFAULT_ACCEPTED = ['.pdf', '.jpg', '.jpeg', '.png'];
  const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
  }

  function getFileIcon(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'ri-file-pdf-line text-danger';
    if (['jpg', 'jpeg', 'png'].includes(ext)) return 'ri-image-line text-success';
    if (ext === 'docx') return 'ri-file-word-2-line text-primary';
    return 'ri-file-text-line text-primary';
  }

  function initDropzone(options) {
    const container = typeof options.container === 'string'
      ? document.querySelector(options.container)
      : options.container;
    if (!container) return null;

    const input = typeof options.input === 'string'
      ? document.querySelector(options.input)
      : options.input;
    if (!input) return null;

    const maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE;
    const acceptedExtensions = options.acceptedExtensions || DEFAULT_ACCEPTED;
    const compact = !!options.compact;
    const onFileSelected = options.onFileSelected || null;
    const onFileRemoved = options.onFileRemoved || null;
    const onError = options.onError || null;

    container.classList.add('ciprms-dropzone-container');
    if (compact) container.classList.add('ciprms-dropzone-compact');

    // Create wrapper markup if not already present
    let dropzone = container.querySelector('.ciprms-dropzone');
    if (!dropzone) {
      dropzone = document.createElement('div');
      dropzone.className = 'ciprms-dropzone';
      dropzone.setAttribute('tabindex', '0');
      dropzone.setAttribute('role', 'button');
      dropzone.setAttribute('aria-label', options.label || 'Upload file');

      dropzone.innerHTML = `
        <div class="ciprms-dropzone-prompt ${compact ? 'd-flex align-items-center gap-3 py-1' : 'text-center py-2'}">
          <div class="ciprms-dropzone-icon ${compact ? 'avatar-xs flex-shrink-0' : 'mb-2'}">
            <span class="avatar-title rounded-circle bg-primary-subtle text-primary ${compact ? 'fs-4' : 'fs-1 mx-auto'}" style="${compact ? 'width: 32px; height: 32px;' : 'width: 52px; height: 52px;'}">
              <i class="${compact ? 'ri-upload-cloud-line' : 'ri-upload-cloud-2-line'}"></i>
            </span>
          </div>
          <div class="ciprms-dropzone-text ${compact ? 'text-start flex-grow-1' : ''}">
            <div class="ciprms-dropzone-title ${compact ? 'fs-13' : 'fs-15'} fw-semibold mb-1 text-dark">${options.title || 'Upload Document'}</div>
            <p class="ciprms-dropzone-desc ${compact ? 'fs-12' : 'fs-13'} text-muted mb-0">${options.desc || 'PDF, JPG, JPEG, or PNG · Max 10MB'}</p>
          </div>
          ${compact ? '<span class="btn btn-sm btn-soft-primary flex-shrink-0 px-2 py-1 fs-12"><i class="ri-folder-open-line me-1"></i>Browse</span>' : ''}
        </div>
        <div class="ciprms-dropzone-preview" style="display:none;">
          <div class="d-flex align-items-center justify-content-between p-2 rounded bg-light-subtle border">
            <div class="d-flex align-items-center text-truncate me-2">
              <div class="avatar-xs flex-shrink-0 me-2">
                <span class="avatar-title rounded bg-light border">
                  <i class="ciprms-file-icon fs-4"></i>
                </span>
              </div>
              <div class="text-truncate text-start">
                <div class="ciprms-file-name fw-semibold text-dark fs-13 text-truncate"></div>
                <div class="ciprms-file-size text-muted fs-11"></div>
              </div>
            </div>
            <div class="d-flex align-items-center gap-1 flex-shrink-0">
              <button type="button" class="btn btn-sm btn-soft-secondary ciprms-btn-reselect" title="Change file">
                <i class="ri-refresh-line me-1"></i>Change
              </button>
              <button type="button" class="btn btn-sm btn-soft-danger ciprms-btn-remove" title="Remove file">
                <i class="ri-close-line"></i>
              </button>
            </div>
          </div>
        </div>
        <div class="ciprms-dropzone-error alert alert-danger py-2 px-3 mt-2 fs-13 mb-0" style="display:none;"></div>
      `;

      input.classList.add('ciprms-hidden-input');
      container.insertBefore(dropzone, input);
    }

    const promptEl = dropzone.querySelector('.ciprms-dropzone-prompt');
    const previewEl = dropzone.querySelector('.ciprms-dropzone-preview');
    const errorEl = dropzone.querySelector('.ciprms-dropzone-error');
    const nameEl = dropzone.querySelector('.ciprms-file-name');
    const sizeEl = dropzone.querySelector('.ciprms-file-size');
    const iconEl = dropzone.querySelector('.ciprms-file-icon');
    const reselectBtn = dropzone.querySelector('.ciprms-btn-reselect');
    const removeBtn = dropzone.querySelector('.ciprms-btn-remove');

    function showError(msg) {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
      }
      if (typeof onError === 'function') onError(msg);
    }

    function clearError() {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
    }

    function validateFile(file) {
      if (!file) return { valid: false, error: 'No file selected.' };
      const name = file.name || '';
      const ext = '.' + name.split('.').pop().toLowerCase();
      if (!acceptedExtensions.includes(ext)) {
        return {
          valid: false,
          error: 'Unsupported file format. Please upload ' + acceptedExtensions.join(', ') + '.'
        };
      }
      if (file.size > maxSizeBytes) {
        return {
          valid: false,
          error: 'File is too large (' + formatBytes(file.size) + '). Maximum allowed size is ' + formatBytes(maxSizeBytes) + '.'
        };
      }
      return { valid: true };
    }

    function setFile(file) {
      clearError();
      const validation = validateFile(file);
      if (!validation.valid) {
        showError(validation.error);
        return false;
      }

      // Update native input's files via DataTransfer so standard forms see it
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
      } catch (err) {
        // Fallback for older browsers
      }

      if (nameEl) nameEl.textContent = file.name;
      if (sizeEl) sizeEl.textContent = formatBytes(file.size);
      if (iconEl) iconEl.className = 'ciprms-file-icon fs-2 me-2 ' + getFileIcon(file.name);
      promptEl.style.display = 'none';
      previewEl.style.display = 'block';

      if (typeof onFileSelected === 'function') {
        onFileSelected(file);
      }
      return true;
    }

    function removeFile(e) {
      if (e) e.stopPropagation();
      input.value = '';
      clearError();
      previewEl.style.display = 'none';
      promptEl.style.display = compact ? 'flex' : 'flex';
      if (typeof onFileRemoved === 'function') {
        onFileRemoved();
      }
    }

    // Drag-and-drop state visual changes
    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('ciprms-dropzone-dragover');
      }, false);
    });

    ['dragleave', 'dragend'].forEach(eventName => {
      dropzone.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('ciprms-dropzone-dragover');
      }, false);
    });

    dropzone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('ciprms-dropzone-dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        setFile(files[0]);
      }
    }, false);

    // Clicking dropzone triggers file picker
    dropzone.addEventListener('click', function (e) {
      if (e.target.closest('.ciprms-btn-remove') || e.target.closest('.ciprms-btn-reselect')) return;
      input.click();
    });

    // Keyboard support
    dropzone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    // Native file input listener
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) {
        setFile(input.files[0]);
      }
    });

    if (removeBtn) removeBtn.addEventListener('click', removeFile);
    if (reselectBtn) reselectBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      input.click();
    });

    return {
      setFile,
      removeFile,
      reset: removeFile,
      showError,
      clearError,
      getFile: () => (input.files && input.files[0]) || null
    };
  }

  window.CIPRMS = window.CIPRMS || {};
  window.CIPRMS.initDropzone = initDropzone;
})(window);
