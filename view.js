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
let scale = 1;

let rendering = false;
let renderTask = null;
let loadingTask = null;

let loadVersion = 0;


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
   LẤY THÔNG TIN THIẾT BỊ
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
   LẤY MÃ LỖI
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
    ).toUpperCase();
}


function getResultMessage(result, fallback) {
    return (
        result?.message ||
        result?.error ||
        result?.data?.message ||
        result?.result?.message ||
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
   - Chỉ gọi /check
   - Không gọi /renew
   - Không gọi /register
========================================================= */

async function checkDeviceAPI(deviceId) {
    const url = new URL(
        "/check",
        WORKER_URL.replace(/\/+$/, "") + "/"
    );

    url.searchParams.set("deviceId", deviceId);
    url.searchParams.set("_refresh", Date.now());

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
   1. Đọc deviceId và deviceToken đã lưu
   2. Gọi /check
   3. Nếu bị khóa, hết hạn hoặc không hợp lệ: dừng
   4. Nếu hợp lệ: cho phép tiếp tục tải PDF

   KHÔNG ĐĂNG KÝ VÀ KHÔNG GIA HẠN TẠI TRANG PDF.
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

    // Chỉ gọi CHECK, không gọi RENEW hoặc REGISTER.
    const result = await checkDeviceAPI(
        credentials.deviceId
    );

    const code = getErrorCode(result);
    const status = String(
        result.status || result.data?.status || ""
    ).toLowerCase();

    const message = String(
        getResultMessage(result, "")
    ).toLowerCase();

    // Kiểm tra thiết bị bị khóa.
    if (
        result.locked === true ||
        result.isLocked === true ||
        result.data?.locked === true ||
        result.data?.isLocked === true ||
        status === "locked" ||
        code === "DEVICE_LOCKED"
    ) {
        const error = new Error(
            "Thiết bị đã bị khóa và không được phép xem tài liệu."
        );

        error.code = "DEVICE_LOCKED";
        throw error;
    }

    // Kiểm tra thiết bị chưa đăng ký.
    if (
        result.registered === false ||
        result.exists === false ||
        result.data?.registered === false ||
        result.data?.exists === false ||
        code === "DEVICE_UNREGISTERED" ||
        code === "DEVICE_NOT_FOUND"
    ) {
        const error = new Error(
            "Thiết bị chưa được đăng ký. Trang xem PDF không có quyền đăng ký thiết bị."
        );

        error.code = "DEVICE_UNREGISTERED";
        throw error;
    }

    // Kiểm tra hết hạn.
    if (
        result.expired === true ||
        result.isExpired === true ||
        result.tokenExpired === true ||
        result.data?.expired === true ||
        result.data?.isExpired === true ||
        status === "expired" ||
        code === "DEVICE_EXPIRED" ||
        code === "TOKEN_EXPIRED" ||
        code === "DEVICE_TOKEN_EXPIRED"
    ) {
        const error = new Error(
            "Xác thực thiết bị đã hết hạn. Vui lòng quay lại trang chủ để xác thực lại."
        );

        error.code = "DEVICE_EXPIRED";
        throw error;
    }

    // Kiểm tra phản hồi lỗi liên quan đến hết hạn.
    if (
        message.includes("device expired") ||
        message.includes("token expired") ||
        message.includes("đã hết hạn") ||
        message.includes("hết hạn")
    ) {
        const error = new Error(
            "Xác thực thiết bị đã hết hạn. Vui lòng quay lại trang chủ để xác thực lại."
        );

        error.code = "DEVICE_EXPIRED";
        throw error;
    }

    // Kiểm tra thông tin xác thực không hợp lệ.
    if (
        result.success === false ||
        result.ok === false ||
        result.valid === false ||
        result.authorized === false ||
        result.data?.valid === false ||
        result.data?.authorized === false ||
        code === "DEVICE_INVALID" ||
        code === "TOKEN_INVALID" ||
        code === "DEVICE_CHECK_FAILED"
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

    /*
     * Chỉ chấp nhận khi Worker xác nhận rõ ràng
     * thiết bị hợp lệ hoặc đã đăng ký.
     *
     * Điều chỉnh các trường này nếu JSON thực tế
     * của Worker sử dụng cấu trúc khác.
     */

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
        result.data?.ok === true;

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

    // Không gọi API nào khác tại đây.
    // Trả thông tin đã có để tải PDF.
    return credentials;
}


/* =========================================================
   URL PDF
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

        // Bước 1: CHECK thiết bị.
        // Nếu không hợp lệ, hàm sẽ dừng tại đây.
        const credentials = await authenticateDevice();

        if (currentLoad !== loadVersion) return;

        // Bước 2: Chỉ khi CHECK hợp lệ mới tải PDF.
        setLoading("Đang tải tài liệu PDF...");

        const pdfUrl = getPDFUrl();

        console.log("PDF URL:", pdfUrl);

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
        rendering = false;

        setFileName();

        if (loading) loading.classList.add("hidden");
        if (errorBox) errorBox.classList.add("hidden");
        if (pdfContainer) pdfContainer.classList.remove("hidden");

        updateZoomText();
        updatePageControls();

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
    if (!pdf || rendering || !canvas) return;

    rendering = true;

    const currentPDF = pdf;

    try {
        currentPage = Math.max(
            1,
            Math.min(pageNumber, currentPDF.numPages)
        );

        updatePageControls();

        const page = await currentPDF.getPage(currentPage);

        if (currentPDF !== pdf) return;

        const viewport = page.getViewport({ scale });

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

        if (currentPDF !== pdf) return;

        updateZoomText();
        updatePageControls();

    } catch (error) {
        if (error?.name === "RenderingCancelledException") {
            return;
        }

        console.error("RENDER ERROR:", error);

        if (currentPDF === pdf) {
            showError("Không thể hiển thị trang PDF.");
        }

    } finally {
        rendering = false;
        renderTask = null;
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
    rendering = false;
}


/* =========================================================
   ĐIỀU HƯỚNG TRANG
========================================================= */

if (pagePrev) {
    pagePrev.addEventListener("click", async () => {
        if (!pdf || rendering || currentPage <= 1) return;

        await renderPage(currentPage - 1);
    });
}

if (pageNext) {
    pageNext.addEventListener("click", async () => {
        if (
            !pdf ||
            rendering ||
            currentPage >= pdf.numPages
        ) {
            return;
        }

        await renderPage(currentPage + 1);
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
    zoomIn.addEventListener("click", async () => {
        if (!pdf || rendering) return;

        scale = Math.min(
            MAX_SCALE,
            Number((scale + SCALE_STEP).toFixed(2))
        );

        await renderPage(currentPage);
    });
}

if (zoomOut) {
    zoomOut.addEventListener("click", async () => {
        if (!pdf || rendering) return;

        scale = Math.max(
            MIN_SCALE,
            Number((scale - SCALE_STEP).toFixed(2))
        );

        await renderPage(currentPage);
    });
}


function updateZoomText() {
    if (zoomValue) {
        zoomValue.textContent =
            Math.round(scale * 100) + "%";
    }

    if (zoomIn) {
        zoomIn.disabled = scale >= MAX_SCALE;
    }

    if (zoomOut) {
        zoomOut.disabled = scale <= MIN_SCALE;
    }
}


/* =========================================================
   RESET VIEWER
========================================================= */

async function resetViewer() {
    loadVersion++;

    await destroyPDF();

    currentPage = 1;
    scale = 1;
    rendering = false;

    updateZoomText();
    updatePageControls();
}


/* =========================================================
   TẢI LẠI PDF
========================================================= */

if (reloadButton) {
    reloadButton.addEventListener("click", async () => {
        if (reloadButton.disabled || loadingTask) return;

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
        if (retryButton.disabled || loadingTask) return;

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
        currentPage > 1 &&
        !rendering
    ) {
        event.preventDefault();
        await renderPage(currentPage - 1);
        return;
    }

    if (
        key === "arrowright" &&
        pdf &&
        currentPage < pdf.numPages &&
        !rendering
    ) {
        event.preventDefault();
        await renderPage(currentPage + 1);
        return;
    }

    if (
        (key === "+" || key === "=") &&
        pdf &&
        !rendering &&
        zoomIn
    ) {
        event.preventDefault();
        zoomIn.click();
        return;
    }

    if (
        (key === "-" || key === "_") &&
        pdf &&
        !rendering &&
        zoomOut
    ) {
        event.preventDefault();
        zoomOut.click();
        return;
    }

    if (key === "0" && pdf && !rendering) {
        event.preventDefault();
        scale = 1;
        await renderPage(currentPage);
        return;
    }

    if (key === "home" && pdf && !rendering) {
        event.preventDefault();
        await renderPage(1);
        return;
    }

    if (key === "end" && pdf && !rendering) {
        event.preventDefault();
        await renderPage(pdf.numPages);
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