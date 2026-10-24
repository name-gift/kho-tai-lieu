
"use strict";

/* =========================================================
   CẤU HÌNH
========================================================= */

const WORKER_URL =
    "https://api-tai-lieu.abcd1601ab.workers.dev";

const PDFJS_WORKER =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.1;
const MAX_DEVICE_PIXEL_RATIO = 2.5;

const STORAGE_DEVICE_ID =
    "kho_tai_lieu_device_id_v1";

const STORAGE_DEVICE_TOKEN =
    "kho_tai_lieu_device_token_v1";

const API_TIMEOUT = 20000;

// Khoảng trống hai bên trang PDF.
const PDF_HORIZONTAL_PADDING = 24;

// Không để canvas quá lớn trên màn hình rộng.
const DESKTOP_MAX_PAGE_WIDTH = 1400;


/* =========================================================
   KHỞI TẠO PDF.JS
========================================================= */

if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
} else {
    console.error("PDF.js chưa được tải.");
}


/* =========================================================
   THAM SỐ URL
========================================================= */

const params = new URLSearchParams(location.search);

const fileId = params.get("id");
const queryFileName = params.get("name");


/* =========================================================
   DOM
========================================================= */

const fileName = document.getElementById("fileName");
const loading = document.getElementById("loading");
const errorBox = document.getElementById("error");
const errorMessage = document.getElementById("errorMessage");
const pdfContainer = document.getElementById("pdfContainer");
const canvas = document.getElementById("pdfCanvas");

const zoomIn = document.getElementById("zoomIn");
const zoomOut = document.getElementById("zoomOut");
const zoomValue = document.getElementById("zoomValue");

const fullscreenButton =
    document.getElementById("fullscreenButton");

const backButton = document.getElementById("backButton");
const pagePrev = document.getElementById("pagePrev");
const pageNext = document.getElementById("pageNext");
const pageInfo = document.getElementById("pageInfo");

const retryButton = document.getElementById("retryButton");
const reloadButton = document.getElementById("reloadButton");


/* =========================================================
   BIẾN
========================================================= */

let pdf = null;
let currentPage = 1;

// Tỷ lệ hiển thị hiện tại.
let scale = 1;

// Tỷ lệ tự động vừa chiều rộng.
let fitScale = 1;

// Người dùng đã tự chỉnh zoom hay chưa.
let manualZoom = false;

let rendering = false;
let renderTask = null;
let loadingTask = null;

let loadVersion = 0;
let resizeTimer = null;
let renderQueued = false;


/* =========================================================
   KHỞI ĐỘNG
========================================================= */

init();

async function init() {
    setInitialUI();

    if (!fileId) {
        showError("Không có mã tài liệu.");
        return;
    }

    if (typeof pdfjsLib === "undefined") {
        showError("Không thể tải thư viện PDF.js.");
        return;
    }

    setFileName();

    await loadPDF();
}


/* =========================================================
   GIAO DIỆN BAN ĐẦU
========================================================= */

function setInitialUI() {
    if (fileName) {
        fileName.textContent = "Đang tải...";
    }

    if (pageInfo) {
        pageInfo.textContent = "1 / 1";
    }

    if (zoomValue) {
        zoomValue.textContent = "100%";
    }

    if (pagePrev) pagePrev.disabled = true;
    if (pageNext) pageNext.disabled = true;

    if (zoomIn) zoomIn.disabled = true;
    if (zoomOut) zoomOut.disabled = true;
}


/* =========================================================
   TÊN FILE
========================================================= */

function setFileName() {
    if (!fileName) return;

    fileName.textContent =
        queryFileName && queryFileName.trim()
            ? queryFileName.trim()
            : "Tài liệu PDF";
}


/* =========================================================
   THÔNG TIN THIẾT BỊ
========================================================= */

function getDeviceCredentials() {
    try {
        return {
            deviceId:
                localStorage.getItem(STORAGE_DEVICE_ID) || "",

            deviceToken:
                localStorage.getItem(STORAGE_DEVICE_TOKEN) || ""
        };
    } catch (error) {
        console.error(
            "Không đọc được thông tin thiết bị:",
            error
        );

        return {
            deviceId: "",
            deviceToken: ""
        };
    }
}


/* =========================================================
   XỬ LÝ PHẢN HỒI API
========================================================= */

function getErrorCode(result) {
    if (!result || typeof result !== "object") {
        return "";
    }

    return String(
        result.code ||
        result.errorCode ||
        result.data?.code ||
        result.result?.code ||
        ""
    ).trim().toUpperCase();
}


function getResultMessage(result, fallback) {
    return (
        result?.message ||
        result?.error_description ||
        result?.data?.message ||
        result?.result?.message ||
        (
            typeof result?.error === "string"
                ? result.error
                : ""
        ) ||
        fallback
    );
}


function makeApiError(result, status, fallback) {
    const error = new Error(
        getResultMessage(result, fallback)
    );

    error.code = getErrorCode(result);
    error.status = status;

    return error;
}


/* =========================================================
   GỌI API CHECK
   Chỉ gọi /check.
   Không gọi /renew hoặc /register tại trang PDF.
========================================================= */

async function checkDeviceAPI(deviceId) {
    const url = new URL(
        "/check",
        WORKER_URL.replace(/\/+$/, "") + "/"
    );

    url.searchParams.set("deviceId", deviceId);
    url.searchParams.set("_refresh", Date.now().toString());

    const controller = new AbortController();

    const timeoutId = setTimeout(
        () => controller.abort(),
        API_TIMEOUT
    );

    try {
        const response = await fetch(url.toString(), {
            method: "GET",
            cache: "no-store",
            headers: {
                Accept: "application/json"
            },
            signal: controller.signal
        });

        let result;

        try {
            result = await response.json();
        } catch {
            const error = new Error(
                "Worker không trả về JSON hợp lệ khi kiểm tra thiết bị."
            );

            error.status = response.status;
            throw error;
        }

        if (!response.ok) {
            throw makeApiError(
                result,
                response.status,
                "Không thể kiểm tra thiết bị."
            );
        }

        return result;

    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(
                "Máy chủ phản hồi quá thời gian cho phép."
            );
        }

        throw error;

    } finally {
        clearTimeout(timeoutId);
    }
}


/* =========================================================
   XÁC THỰC THIẾT BỊ

   1. Đọc deviceId và deviceToken đã lưu.
   2. Gọi /check bằng deviceId.
   3. Nếu bị khóa, hết hạn hoặc không hợp lệ: dừng.
   4. Nếu hợp lệ: cho phép tải PDF.

   Không đăng ký hoặc gia hạn tại trang PDF.
========================================================= */

async function authenticateDevice() {
    const credentials = getDeviceCredentials();

    if (!credentials.deviceId) {
        const error = new Error(
            "Không tìm thấy mã thiết bị. Vui lòng quay lại trang chủ."
        );

        error.code = "DEVICE_CREDENTIALS_MISSING";
        throw error;
    }

    if (!credentials.deviceToken) {
        const error = new Error(
            "Không tìm thấy token thiết bị. Vui lòng quay lại trang chủ để xác thực lại."
        );

        error.code = "DEVICE_TOKEN_MISSING";
        throw error;
    }

    const result = await checkDeviceAPI(
        credentials.deviceId
    );

    const code = getErrorCode(result);

    const status = String(
        result.status || result.data?.status || ""
    ).trim().toLowerCase();

    const message = String(
        getResultMessage(result, "")
    ).toLowerCase();

    const isLocked =
        result.locked === true ||
        result.isLocked === true ||
        result.data?.locked === true ||
        result.data?.isLocked === true ||
        status === "locked" ||
        code === "DEVICE_LOCKED";

    if (isLocked) {
        const error = new Error(
            "Thiết bị đã bị khóa và không được phép xem tài liệu."
        );

        error.code = "DEVICE_LOCKED";
        throw error;
    }

    const isUnregistered =
        result.registered === false ||
        result.exists === false ||
        result.data?.registered === false ||
        result.data?.exists === false ||
        code === "DEVICE_UNREGISTERED" ||
        code === "DEVICE_NOT_FOUND";

    if (isUnregistered) {
        const error = new Error(
            "Thiết bị chưa được đăng ký. Vui lòng quay lại trang chủ."
        );

        error.code = "DEVICE_UNREGISTERED";
        throw error;
    }

    const isExpired =
        result.expired === true ||
        result.isExpired === true ||
        result.tokenExpired === true ||
        result.data?.expired === true ||
        result.data?.isExpired === true ||
        status === "expired" ||
        code === "DEVICE_EXPIRED" ||
        code === "TOKEN_EXPIRED" ||
        code === "DEVICE_TOKEN_EXPIRED" ||
        message.includes("device expired") ||
        message.includes("token expired") ||
        message.includes("đã hết hạn") ||
        message.includes("hết hạn");

    if (isExpired) {
        const error = new Error(
            "Xác thực thiết bị đã hết hạn. Vui lòng quay lại trang chủ."
        );

        error.code = "DEVICE_EXPIRED";
        throw error;
    }

    if (
        result.success === false ||
        result.ok === false ||
        result.valid === false ||
        result.authorized === false ||
        result.data?.valid === false ||
        result.data?.authorized === false ||
        [
            "DEVICE_INVALID",
            "TOKEN_INVALID",
            "DEVICE_CHECK_FAILED"
        ].includes(code)
    ) {
        const error = new Error(
            getResultMessage(
                result,
                "Thông tin xác thực thiết bị không hợp lệ."
            )
        );

        error.code = code || "DEVICE_CHECK_FAILED";
        throw error;
    }

    const explicitlyValid =
        result.valid === true ||
        result.authorized === true ||
        result.registered === true ||
        result.exists === true ||
        result.success === true ||
        result.ok === true ||
        result.data?.valid === true ||
        result.data?.authorized === true ||
        result.data?.registered === true ||
        result.data?.exists === true ||
        result.data?.success === true ||
        result.data?.ok === true ||
        status === "active";

    if (!explicitlyValid) {
        const error = new Error(
            getResultMessage(
                result,
                "Worker chưa xác nhận thiết bị hợp lệ. Không tải PDF."
            )
        );

        error.code = code || "DEVICE_CHECK_FAILED";
        throw error;
    }

    return credentials;
}


/* =========================================================
   LẤY URL PDF
========================================================= */

function getPDFUrl() {
    const baseURL = WORKER_URL.replace(/\/+$/, "");

    return (
        baseURL +
        "/pdf?id=" +
        encodeURIComponent(fileId)
    );
}


/* =========================================================
   TÍNH TỶ LỆ TỰ ĐỘNG THEO THIẾT BỊ

   - Dựa vào chiều rộng thực tế của vùng xem.
   - Trừ phần lề để không tràn màn hình.
   - Giới hạn mức zoom theo MIN_SCALE/MAX_SCALE.
   - Không dùng devicePixelRatio để phóng to CSS.
========================================================= */

function getAvailablePageWidth() {
    let availableWidth = 0;

    if (pdfContainer) {
        availableWidth = pdfContainer.clientWidth;
    }

    if (!availableWidth) {
        availableWidth =
            document.documentElement.clientWidth ||
            window.innerWidth ||
            320;
    }

    // Trên máy tính, giới hạn độ rộng trang để dễ đọc.
    if (availableWidth > 768) {
        availableWidth = Math.min(
            availableWidth,
            DESKTOP_MAX_PAGE_WIDTH
        );
    }

    availableWidth -= PDF_HORIZONTAL_PADDING;

    return Math.max(200, availableWidth);
}


async function calculateFitScale(pageNumber = 1) {
    if (!pdf) return 1;

    try {
        const page = await pdf.getPage(pageNumber);

        const baseViewport = page.getViewport({
            scale: 1
        });

        const availableWidth = getAvailablePageWidth();

        const calculatedScale =
            availableWidth / baseViewport.width;

        return clamp(
            calculatedScale,
            MIN_SCALE,
            MAX_SCALE
        );

    } catch (error) {
        console.warn(
            "Không thể tính tỷ lệ vừa trang:",
            error
        );

        return 1;
    }
}


function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}


/* =========================================================
   TẢI PDF
========================================================= */

async function loadPDF() {
    const currentLoad = ++loadVersion;

    try {
        setLoading("Đang kiểm tra thiết bị...");

        if (!fileId) {
            throw new Error("Không có mã tài liệu.");
        }

        if (typeof pdfjsLib === "undefined") {
            throw new Error("Không thể tải thư viện PDF.js.");
        }

        // Bước 1: xác thực thiết bị.
        const credentials = await authenticateDevice();

        if (currentLoad !== loadVersion) return;

        // Bước 2: chỉ sau khi hợp lệ mới tải PDF.
        setLoading("Đang tải tài liệu PDF...");

        const pdfUrl = getPDFUrl();

        const task = pdfjsLib.getDocument({
            url: pdfUrl,

            httpHeaders: {
                "X-Device-Id": credentials.deviceId,
                "X-Device-Token": credentials.deviceToken
            },

            withCredentials: false,
            disableAutoFetch: false,
            disableStream: false
        });

        loadingTask = task;

        const loadedPDF = await task.promise;

        if (currentLoad !== loadVersion) {
            try {
                await loadedPDF.destroy();
            } catch (error) {
                console.warn(
                    "Không thể giải phóng PDF cũ:",
                    error
                );
            }

            return;
        }

        if (!loadedPDF || !loadedPDF.numPages) {
            throw new Error("PDF không có trang.");
        }

        pdf = loadedPDF;
        currentPage = 1;
        scale = 1;
        fitScale = 1;
        manualZoom = false;
        rendering = false;

        setFileName();

        if (loading) loading.classList.add("hidden");
        if (errorBox) errorBox.classList.add("hidden");
        if (pdfContainer) pdfContainer.classList.remove("hidden");

        // Tự động vừa chiều rộng ngay khi tải xong.
        fitScale = await calculateFitScale(currentPage);
        scale = fitScale;

        updateZoomText();
        updatePageControls();

        if (currentLoad !== loadVersion) return;

        await renderPage(currentPage);

    } catch (error) {
        if (currentLoad !== loadVersion) return;

        console.error("PDF VIEWER ERROR:", error);

        showError(getErrorMessage(error));

    } finally {
        if (currentLoad === loadVersion) {
            loadingTask = null;
        }
    }
}


/* =========================================================
   RENDER TRANG PDF
========================================================= */

async function renderPage(pageNumber) {
    if (!pdf || !canvas) return;

    // Nếu đang render, đánh dấu cần render lại sau đó.
    if (rendering) {
        renderQueued = true;
        return;
    }

    rendering = true;

    const currentPDF = pdf;
    const currentLoad = loadVersion;

    try {
        currentPage = clamp(
            pageNumber,
            1,
            currentPDF.numPages
        );

        updatePageControls();

        const page = await currentPDF.getPage(currentPage);

        if (
            currentPDF !== pdf ||
            currentLoad !== loadVersion
        ) {
            return;
        }

        const viewport = page.getViewport({
            scale
        });

        // DPR chỉ nâng độ nét canvas, không làm trang
        // hiển thị lớn hơn kích thước CSS.
        const pixelRatio = Math.min(
            window.devicePixelRatio || 1,
            MAX_DEVICE_PIXEL_RATIO
        );

        const renderWidth = Math.max(
            1,
            Math.floor(viewport.width * pixelRatio)
        );

        const renderHeight = Math.max(
            1,
            Math.floor(viewport.height * pixelRatio)
        );

        canvas.width = renderWidth;
        canvas.height = renderHeight;

        canvas.style.width =
            Math.floor(viewport.width) + "px";

        canvas.style.height =
            Math.floor(viewport.height) + "px";

        const context = canvas.getContext("2d", {
            alpha: false
        });

        if (!context) {
            throw new Error("Không thể tạo canvas.");
        }

        context.fillStyle = "#ffffff";

        context.fillRect(
            0,
            0,
            renderWidth,
            renderHeight
        );

        const task = page.render({
            canvasContext: context,
            viewport,

            transform: [
                pixelRatio, 0,
                0, pixelRatio,
                0, 0
            ],

            intent: "display"
        });

        renderTask = task;

        await task.promise;

        if (
            currentPDF !== pdf ||
            currentLoad !== loadVersion
        ) {
            return;
        }

        updateZoomText();
        updatePageControls();

    } catch (error) {
        if (
            error?.name === "RenderingCancelledException"
        ) {
            return;
        }

        console.error("RENDER ERROR:", error);

        if (currentPDF === pdf) {
            showError("Không thể hiển thị trang PDF.");
        }

    } finally {
        rendering = false;
        renderTask = null;

        // Nếu trong lúc render có thao tác đổi trang,
        // zoom hoặc thay đổi kích thước, render lại.
        if (renderQueued && pdf) {
            renderQueued = false;

            requestAnimationFrame(() => {
                renderPage(currentPage);
            });
        }
    }
}


/* =========================================================
   HỦY RENDER VÀ XÓA CANVAS
========================================================= */

function cancelRender() {
    if (renderTask?.cancel) {
        try {
            renderTask.cancel();
        } catch (error) {
            console.warn(
                "Không thể hủy render:",
                error
            );
        }
    }

    renderTask = null;
}


function clearCanvas() {
    if (!canvas) return;

    try {
        const context = canvas.getContext("2d");

        if (context) {
            context.clearRect(
                0,
                0,
                canvas.width,
                canvas.height
            );
        }
    } catch (error) {
        console.warn("Không thể xóa canvas:", error);
    }

    canvas.width = 0;
    canvas.height = 0;

    canvas.style.width = "";
    canvas.style.height = "";
}


/* =========================================================
   GIẢI PHÓNG PDF
========================================================= */

async function destroyPDF() {
    cancelRender();

    const oldLoadingTask = loadingTask;
    const oldPDF = pdf;

    loadingTask = null;
    pdf = null;

    rendering = false;
    renderQueued = false;

    if (oldLoadingTask) {
        try {
            await oldLoadingTask.destroy();
        } catch (error) {
            console.warn(
                "Không thể hủy loading PDF:",
                error
            );
        }
    }

    if (oldPDF) {
        try {
            await oldPDF.destroy();
        } catch (error) {
            console.warn(
                "Không thể giải phóng PDF:",
                error
            );
        }
    }

    clearCanvas();
}


/* =========================================================
   ĐIỀU HƯỚNG TRANG
========================================================= */

if (pagePrev) {
    pagePrev.addEventListener("click", () => {
        if (!pdf || currentPage <= 1) return;

        renderPage(currentPage - 1);
    });
}

if (pageNext) {
    pageNext.addEventListener("click", () => {
        if (!pdf || currentPage >= pdf.numPages) return;

        renderPage(currentPage + 1);
    });
}


function updatePageControls() {
    if (!pageInfo) return;

    if (!pdf) {
        pageInfo.textContent = "1 / 1";

        if (pagePrev) pagePrev.disabled = true;
        if (pageNext) pageNext.disabled = true;

        return;
    }

    pageInfo.textContent =
        currentPage + " / " + pdf.numPages;

    if (pagePrev) {
        pagePrev.disabled = currentPage <= 1;
    }

    if (pageNext) {
        pageNext.disabled =
            currentPage >= pdf.numPages;
    }
}


/* =========================================================
   PHÓNG TO / THU NHỎ
========================================================= */

if (zoomIn) {
    zoomIn.addEventListener("click", () => {
        if (!pdf) return;

        manualZoom = true;

        scale = clamp(
            Number((scale + SCALE_STEP).toFixed(2)),
            MIN_SCALE,
            MAX_SCALE
        );

        updateZoomText();
        renderPage(currentPage);
    });
}

if (zoomOut) {
    zoomOut.addEventListener("click", () => {
        if (!pdf) return;

        manualZoom = true;

        scale = clamp(
            Number((scale - SCALE_STEP).toFixed(2)),
            MIN_SCALE,
            MAX_SCALE
        );

        updateZoomText();
        renderPage(currentPage);
    });
}


function updateZoomText() {
    if (zoomValue) {
        zoomValue.textContent =
            Math.round(scale * 100) + "%";
    }

    if (zoomIn) {
        zoomIn.disabled =
            !pdf || scale >= MAX_SCALE;
    }

    if (zoomOut) {
        zoomOut.disabled =
            !pdf || scale <= MIN_SCALE;
    }
}


/* =========================================================
   TỰ ĐỘNG FIT LẠI KHI ĐỔI KÍCH THƯỚC

   Khi người dùng chưa chỉnh zoom thủ công:
   tự động vừa trang theo chiều rộng mới.

   Khi người dùng đã chỉnh zoom:
   giữ tỷ lệ người dùng chọn, không tự ghi đè.
========================================================= */

async function fitPDFToScreen(force = false) {
    if (!pdf) return;

    if (manualZoom && !force) return;

    const currentLoad = loadVersion;
    const newScale = await calculateFitScale(currentPage);

    if (
        !pdf ||
        currentLoad !== loadVersion
    ) {
        return;
    }

    fitScale = newScale;
    scale = newScale;
    manualZoom = false;

    updateZoomText();
    renderPage(currentPage);
}


function scheduleResizeFit() {
    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(() => {
        if (!pdf) return;

        fitPDFToScreen(false);
    }, 180);
}


window.addEventListener("resize", scheduleResizeFit);

window.addEventListener("orientationchange", () => {
    // Đợi trình duyệt cập nhật kích thước sau khi xoay máy.
    setTimeout(() => {
        fitPDFToScreen(false);
    }, 250);
});


/* =========================================================
   NÚT VỪA TRANG

   Có thể gọi hàm này từ một nút HTML nếu muốn thêm
   nút "Vừa màn hình".
========================================================= */

async function fitToScreen() {
    await fitPDFToScreen(true);
}


/* =========================================================
   RESET VIEWER
========================================================= */

async function resetViewer() {
    loadVersion++;

    await destroyPDF();

    currentPage = 1;
    scale = 1;
    fitScale = 1;
    manualZoom = false;
    rendering = false;
    renderQueued = false;

    updateZoomText();
    updatePageControls();
}


/* =========================================================
   TẢI LẠI PDF
========================================================= */

if (reloadButton) {
    reloadButton.addEventListener("click", async () => {
        if (reloadButton.disabled) return;

        reloadButton.disabled = true;
        reloadButton.classList.add("loading");

        try {
            await resetViewer();
            await loadPDF();
        } catch (error) {
            console.error("RELOAD ERROR:", error);
            showError(getErrorMessage(error));
        } finally {
            reloadButton.disabled = false;
            reloadButton.classList.remove("loading");
        }
    });
}


/* =========================================================
   THỬ LẠI
========================================================= */

if (retryButton) {
    retryButton.addEventListener("click", async () => {
        if (retryButton.disabled) return;

        retryButton.disabled = true;

        try {
            await resetViewer();
            await loadPDF();
        } catch (error) {
            console.error("RETRY ERROR:", error);
            showError(getErrorMessage(error));
        } finally {
            retryButton.disabled = false;
        }
    });
}


/* =========================================================
   TOÀN MÀN HÌNH
========================================================= */

if (fullscreenButton) {
    fullscreenButton.addEventListener("click", async () => {
        try {
            if (!document.fullscreenElement) {
                await document.documentElement.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch (error) {
            console.error("FULLSCREEN ERROR:", error);
        }
    });
}


function updateFullscreenIcon() {
    if (!fullscreenButton) return;

    const icon = fullscreenButton.querySelector("i");

    if (!icon) return;

    if (document.fullscreenElement) {
        icon.classList.remove("fa-expand");
        icon.classList.add("fa-compress");

        fullscreenButton.title = "Thoát toàn màn hình";

        fullscreenButton.setAttribute(
            "aria-label",
            "Thoát toàn màn hình"
        );
    } else {
        icon.classList.remove("fa-compress");
        icon.classList.add("fa-expand");

        fullscreenButton.title = "Toàn màn hình";

        fullscreenButton.setAttribute(
            "aria-label",
            "Toàn màn hình"
        );
    }

    scheduleResizeFit();
}

document.addEventListener(
    "fullscreenchange",
    updateFullscreenIcon
);


/* =========================================================
   QUAY LẠI
========================================================= */

if (backButton) {
    backButton.addEventListener("click", () => {
        if (history.length > 1) {
            history.back();
        } else {
            location.href = "index.html";
        }
    });
}


/* =========================================================
   PHÍM TẮT
========================================================= */

document.addEventListener("keydown", async event => {
    const key = event.key.toLowerCase();
    const target = event.target;

    const isTyping = target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
    );

    if (isTyping) return;

    if (
        (event.ctrlKey || event.metaKey) &&
        ["s", "u", "p"].includes(key)
    ) {
        event.preventDefault();
        return;
    }

    if (
        key === "arrowleft" &&
        pdf &&
        currentPage > 1
    ) {
        event.preventDefault();
        renderPage(currentPage - 1);
        return;
    }

    if (
        key === "arrowright" &&
        pdf &&
        currentPage < pdf.numPages
    ) {
        event.preventDefault();
        renderPage(currentPage + 1);
        return;
    }

    if (
        (key === "+" || key === "=") &&
        pdf &&
        zoomIn &&
        !zoomIn.disabled
    ) {
        event.preventDefault();
        zoomIn.click();
        return;
    }

    if (
        (key === "-" || key === "_") &&
        pdf &&
        zoomOut &&
        !zoomOut.disabled
    ) {
        event.preventDefault();
        zoomOut.click();
        return;
    }

    // Phím 0: tự động vừa màn hình.
    if (key === "0" && pdf) {
        event.preventDefault();
        await fitToScreen();
        return;
    }

    if (key === "home" && pdf) {
        event.preventDefault();
        renderPage(1);
        return;
    }

    if (key === "end" && pdf) {
        event.preventDefault();
        renderPage(pdf.numPages);
    }
});


/* =========================================================
   CHẶN CHUỘT PHẢI
========================================================= */

document.addEventListener("contextmenu", event => {
    event.preventDefault();
});


/* =========================================================
   LOADING
========================================================= */

function setLoading(message) {
    if (loading) {
        loading.classList.remove("hidden");
    }

    if (errorBox) {
        errorBox.classList.add("hidden");
    }

    if (pdfContainer) {
        pdfContainer.classList.add("hidden");
    }

    const text = loading?.querySelector("p");

    if (text) {
        text.textContent = message;
    }
}


/* =========================================================
   HIỂN THỊ LỖI
========================================================= */

function showError(message) {
    if (loading) {
        loading.classList.add("hidden");
    }

    if (pdfContainer) {
        pdfContainer.classList.add("hidden");
    }

    if (errorBox) {
        errorBox.classList.remove("hidden");
    }

    if (errorMessage) {
        errorMessage.textContent = message;
    }

    updatePageControls();
}


/* =========================================================
   XỬ LÝ LỖI
========================================================= */

function getErrorMessage(error) {
    if (!error) {
        return "Không thể tải tài liệu.";
    }

    const code = String(
        error.code || ""
    ).toUpperCase();

    const message = String(
        error.message || error
    );

    const lowerMessage = message.toLowerCase();

    if (
        code === "DEVICE_CREDENTIALS_MISSING" ||
        code === "DEVICE_TOKEN_MISSING" ||
        code === "DEVICE_UNREGISTERED" ||
        code === "DEVICE_NOT_FOUND" ||
        code === "DEVICE_EXPIRED" ||
        code === "DEVICE_CHECK_FAILED"
    ) {
        return message;
    }

    if (code === "DEVICE_LOCKED") {
        return (
            "Thiết bị đã bị khóa và không được phép xem tài liệu."
        );
    }

    if (
        message.includes("Unexpected server response") ||
        message.includes("UnexpectedResponseException")
    ) {
        return (
            "Worker không trả về PDF hợp lệ. Hãy kiểm tra ID tài liệu, " +
            "quyền truy cập và cấu hình xác thực trên Worker."
        );
    }

    if (message.includes("Invalid PDF")) {
        return "Tệp PDF không hợp lệ hoặc đã bị lỗi.";
    }

    if (message.includes("Missing PDF")) {
        return "Không tìm thấy tài liệu PDF.";
    }

    if (
        message.includes("Failed to fetch") ||
        message.includes("NetworkError")
    ) {
        return (
            "Không thể kết nối tới máy chủ PDF. Hãy kiểm tra mạng, " +
            "CORS và cấu hình Worker."
        );
    }

    if (lowerMessage.includes("cors")) {
        return (
            "Máy chủ chưa cho phép kết nối từ trang này. " +
            "Hãy kiểm tra Access-Control-Allow-Origin và " +
            "Access-Control-Allow-Headers trên Worker."
        );
    }

    if (
        lowerMessage.includes("password") ||
        message.includes("PasswordException")
    ) {
        return "Tài liệu PDF được bảo vệ bằng mật khẩu.";
    }

    if (
        message.includes("401") ||
        message.includes("403")
    ) {
        return (
            "Máy chủ từ chối truy cập. Hãy kiểm tra trạng thái thiết bị, " +
            "token và quyền truy cập trên Worker."
        );
    }

    return message || "Không thể tải tài liệu PDF.";
}
