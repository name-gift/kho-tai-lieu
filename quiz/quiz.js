"use strict";

/* ======================== CONFIG ======================== */
const CONFIG = {
    API_BASE: "/quiz/api",
    API_URL: "/quiz/api/list",
    API_TIMEOUT: 20000,
    STORAGE_VIEW: "quiz_view_mode_v1",
    STORAGE_DEVICE_ID: "kho_tai_lieu_device_id_v1",
    STORAGE_DEVICE_TOKEN: "kho_tai_lieu_device_token_v1"
};

/* ======================== STATE ========================= */
const state = {
    quizzes: [],
    filteredQuizzes: [],
    searchText: "",
    viewMode: loadSavedViewMode(),
    loading: false
};

/* ================= DEVICE AUTHENTICATION ================ */

/*
 * QUY TRÌNH XÁC THỰC:
 * 1. /check chỉ gửi deviceId.
 * 2. Nếu thiết bị đang hoạt động hoặc hết hạn: gọi /renew.
 * 3. Nếu thiết bị chưa đăng ký: gọi /register.
 * 4. Lưu token mới nếu Worker trả về.
 * 5. Gọi /list bằng deviceId và token mới nhất.
 *
 * Không tự động đăng ký lại khi gặp lỗi không xác định.
 */

function getDeviceCredentials() {
    try {
        return {
            deviceId: localStorage.getItem(CONFIG.STORAGE_DEVICE_ID) || "",
            deviceToken: localStorage.getItem(CONFIG.STORAGE_DEVICE_TOKEN) || ""
        };
    } catch (error) {
        console.error("Không thể đọc thông tin thiết bị:", error);
        return {
            deviceId: "",
            deviceToken: ""
        };
    }
}

function createDeviceId() {
    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return crypto.randomUUID();
    }

    return (
        "device_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2) +
        Math.random().toString(36).slice(2)
    );
}

function getErrorCode(result) {
    return String(
        result?.code ||
        result?.errorCode ||
        result?.error ||
        result?.reason ||
        ""
    ).trim().toUpperCase();
}

function createApiError(message, code = "") {
    const error = new Error(
        message || "Đã xảy ra lỗi khi gọi API."
    );
    error.code = code;
    return error;
}

async function ensureDeviceRegistered(signal) {
    const credentials = getDeviceCredentials();

    let deviceId = String(credentials.deviceId || "").trim();
    let deviceToken = String(credentials.deviceToken || "").trim();

    if (!deviceId) {
        deviceId = createDeviceId();

        try {
            localStorage.setItem(CONFIG.STORAGE_DEVICE_ID, deviceId);
        } catch (error) {
            throw createApiError(
                "Trình duyệt không cho phép lưu thông tin thiết bị."
            );
        }
    }

    const apiBase = new URL(CONFIG.API_BASE, window.location.origin);

    async function callWorker(path, params = {}) {
        const url = new URL(
            String(path).replace(/^\/+/, ""),
            apiBase.toString().replace(/\/$/, "") + "/"
        );

        url.searchParams.set("deviceId", deviceId);

        const normalizedPath = String(path)
            .replace(/\/+$/, "")
            .toLowerCase();

        if (normalizedPath !== "/check" && deviceToken) {
            url.searchParams.set("deviceToken", deviceToken);
        }

        Object.entries(params).forEach(function([key, value]) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                url.searchParams.set(key, String(value));
            }
        });

        url.searchParams.set("_refresh", Date.now().toString());

        const headers = {
            "Accept": "application/json"
        };

        if (normalizedPath !== "/check") {
            headers["X-Device-Id"] = deviceId;

            if (deviceToken) {
                headers["X-Device-Token"] = deviceToken;
            }
        }

        const response = await fetch(url.toString(), {
            method: "GET",
            headers,
            cache: "no-store",
            signal
        });

        let data;

        try {
            data = await response.json();
        } catch {
            throw createApiError(
                "Worker không trả về JSON hợp lệ khi gọi " +
                path +
                "."
            );
        }

        return {
            response,
            data,
            code: getErrorCode(data)
        };
    }

    function throwWorkerError(result, fallback) {
        throw createApiError(
            result.data?.message ||
            result.data?.error_description ||
            fallback,
            result.code
        );
    }

    function saveReturnedToken(data) {
        const token =
            data?.deviceToken ??
            data?.token ??
            data?.data?.deviceToken ??
            data?.data?.token ??
            data?.result?.deviceToken ??
            data?.result?.token;

        if (
            token === undefined ||
            token === null ||
            String(token).trim() === ""
        ) {
            return false;
        }

        const newToken = String(token).trim();

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_TOKEN,
                newToken
            );
            deviceToken = newToken;
            return true;
        } catch (error) {
            throw createApiError(
                "Đã nhận token mới nhưng không thể lưu vào trình duyệt."
            );
        }
    }

    /* BƯỚC 1: CHECK - chỉ gửi deviceId */
    const check = await callWorker("/check");

    if (check.code === "DEVICE_LOCKED") {
        throwWorkerError(
            check,
            "Thiết bị đã bị khóa và không được phép truy cập."
        );
    }

    const checkStatus = String(
        check.data?.status || ""
    ).trim().toLowerCase();

    const checkSuccess =
        check.response.ok &&
        check.data?.success === true &&
        (
            checkStatus === "active" ||
            checkStatus === "registered" ||
            checkStatus === "valid"
        );

    const deviceExpired = check.code === "DEVICE_EXPIRED";

    const deviceNotRegistered = [
        "DEVICE_UNREGISTERED",
        "DEVICE_NOT_FOUND"
    ].includes(check.code);

    /* BƯỚC 2: RENEW */
    if (checkSuccess || deviceExpired) {
        const renew = await callWorker("/renew");

        if (renew.code === "DEVICE_LOCKED") {
            throwWorkerError(
                renew,
                "Thiết bị đã bị khóa và không được phép truy cập."
            );
        }

        const notExpired = renew.code === "DEVICE_NOT_EXPIRED";
        const renewSuccess =
            renew.response.ok &&
            renew.data?.success === true;

        if (!renewSuccess && !notExpired) {
            throwWorkerError(
                renew,
                "Không thể gia hạn hoặc xác minh thiết bị."
            );
        }

        saveReturnedToken(renew.data);

        return {
            deviceId,
            deviceToken
        };
    }

    /* BƯỚC 3: REGISTER */
    if (deviceNotRegistered) {
        const registration = await callWorker("/register");

        if (
            !registration.response.ok ||
            registration.data?.success !== true
        ) {
            throwWorkerError(
                registration,
                "Đăng ký thiết bị thất bại."
            );
        }

        const returnedDeviceId = String(
            registration.data?.deviceId ||
            registration.data?.data?.deviceId ||
            registration.data?.result?.deviceId ||
            deviceId
        ).trim();

        if (!returnedDeviceId) {
            throw createApiError(
                "Worker không trả về deviceId hợp lệ."
            );
        }

        try {
            localStorage.setItem(
                CONFIG.STORAGE_DEVICE_ID,
                returnedDeviceId
            );
            deviceId = returnedDeviceId;
        } catch (error) {
            throw createApiError(
                "Không thể lưu deviceId vào trình duyệt."
            );
        }

        saveReturnedToken(registration.data);

        return {
            deviceId,
            deviceToken
        };
    }

    throwWorkerError(
        check,
        "Không thể xác minh thiết bị. Vui lòng thử lại."
    );
}

/* ============================ DOM ======================== */
const elements = {};

document.addEventListener("DOMContentLoaded", init);

async function init() {
    initElements();
    bindEvents();
    applyViewMode();
    updateSearchButton();
    await loadQuizzes(false);
}

function initElements() {
    elements.refreshButton =
        document.getElementById("refreshButton");

    elements.searchInput =
        document.getElementById("searchInput");

    elements.clearSearch =
        document.getElementById("clearSearch");

    elements.gridViewButton =
        document.getElementById("gridViewButton");

    elements.listViewButton =
        document.getElementById("listViewButton");

    elements.quizCount =
        document.getElementById("quizCount");

    elements.quizContainer =
        document.getElementById("quizContainer");

    elements.loadingState =
        document.getElementById("loadingState");

    elements.errorState =
        document.getElementById("errorState");

    elements.errorMessage =
        document.getElementById("errorMessage");

    elements.retryButton =
        document.getElementById("retryButton");

    elements.emptyState =
        document.getElementById("emptyState");

    elements.emptyMessage =
        document.getElementById("emptyMessage");

    elements.toast =
        document.getElementById("toast");

    elements.toastMessage =
        document.getElementById("toastMessage");
}

/* ============================ EVENTS ===================== */
function bindEvents() {
    if (elements.refreshButton) {
        elements.refreshButton.addEventListener(
            "click",
            function() {
                loadQuizzes(true);
            }
        );
    }

    if (elements.retryButton) {
        elements.retryButton.addEventListener(
            "click",
            function() {
                loadQuizzes(true);
            }
        );
    }

    if (elements.searchInput) {
        elements.searchInput.addEventListener(
            "input",
            function() {
                state.searchText = this.value
                    .trim()
                    .toLowerCase();

                updateSearchButton();
                filterAndRender();
            }
        );
    }

    if (elements.clearSearch) {
        elements.clearSearch.addEventListener(
            "click",
            function() {
                clearSearch();

                if (elements.searchInput) {
                    elements.searchInput.focus();
                }
            }
        );
    }

    if (elements.gridViewButton) {
        elements.gridViewButton.addEventListener(
            "click",
            function() {
                setViewMode("grid");
            }
        );
    }

    if (elements.listViewButton) {
        elements.listViewButton.addEventListener(
            "click",
            function() {
                setViewMode("list");
            }
        );
    }

    window.addEventListener("keydown", handleKeyboard);
}

/* ======================== LOAD QUIZZES =================== */
async function loadQuizzes(showToast = false) {
    if (state.loading) {
        return;
    }

    state.loading = true;
    setRefreshLoading(true);

    state.quizzes = [];
    state.filteredQuizzes = [];

    if (elements.quizContainer) {
        elements.quizContainer.innerHTML = "";
    }

    updateCount();
    showLoading();

    let controller = null;
    let timeout = null;

    try {
        if (!CONFIG.API_URL) {
            throw createApiError(
                "Chưa cấu hình API_URL trong quiz.js."
            );
        }

        controller = new AbortController();

        timeout = setTimeout(function() {
            controller.abort();
        }, CONFIG.API_TIMEOUT);

        /* BƯỚC 1: CHECK -> RENEW hoặc REGISTER */
        await ensureDeviceRegistered(controller.signal);

        /* BƯỚC 2: Đọc lại thông tin thiết bị */
        const credentials = getDeviceCredentials();

        const deviceId = String(
            credentials.deviceId || ""
        ).trim();

        const deviceToken = String(
            credentials.deviceToken || ""
        ).trim();

        if (!deviceId) {
            throw createApiError(
                "Thiếu deviceId sau khi xác thực thiết bị. " +
                "Vui lòng tải lại trang."
            );
        }

        /* BƯỚC 3: Gọi /list */
        const requestUrl = new URL(
            CONFIG.API_URL,
            window.location.origin
        );

        requestUrl.searchParams.set("deviceId", deviceId);

        if (deviceToken) {
            requestUrl.searchParams.set(
                "deviceToken",
                deviceToken
            );
        }

        requestUrl.searchParams.set(
            "_refresh",
            Date.now().toString()
        );

        const headers = {
            "Accept": "application/json",
            "X-Device-Id": deviceId
        };

        if (deviceToken) {
            headers["X-Device-Token"] = deviceToken;
        }

        const response = await fetch(
            requestUrl.toString(),
            {
                method: "GET",
                headers,
                cache: "no-store",
                signal: controller.signal
            }
        );

        let result;

        try {
            result = await response.json();
        } catch {
            throw createApiError(
                "API Quiz không trả về JSON hợp lệ."
            );
        }

        const errorCode = getErrorCode(result);

        const deviceErrorCodes = [
            "DEVICE_LOCKED",
            "DEVICE_UNREGISTERED",
            "DEVICE_NOT_FOUND",
            "DEVICE_ID_MISSING",
            "DEVICE_EXPIRED",
            "TOKEN_INVALID",
            "TOKEN_MISSING",
            "DEVICE_TOKEN_MISSING",
            "IP_NOT_FOUND",
            "IP_MISSING"
        ];

        if (deviceErrorCodes.includes(errorCode)) {
            throw createApiError(
                result?.message ||
                "Thiết bị chưa được xác thực hoặc không được phép truy cập.",
                errorCode
            );
        }

        if (!response.ok) {
            throw createApiError(
                result?.message ||
                "API trả về HTTP " + response.status,
                errorCode
            );
        }

        if (result?.success === false) {
            throw createApiError(
                result.message ||
                "API Quiz từ chối truy cập.",
                errorCode
            );
        }

        /* BƯỚC 4: Chuẩn hóa dữ liệu */
        const rawQuizzes = normalizeApiData(result);
        state.quizzes = normalizeQuizzes(rawQuizzes);

        filterAndRender();

        if (state.quizzes.length === 0) {
            showEmpty(
                "Hiện chưa có phiên Quiz nào được mở."
            );
        } else if (showToast) {
            showToastMessage(
                "Đã cập nhật dữ liệu phiên Quiz."
            );
        }
    } catch (error) {
        console.error("QUIZ API ERROR:", error);

        state.quizzes = [];
        state.filteredQuizzes = [];

        if (elements.quizContainer) {
            elements.quizContainer.innerHTML = "";
        }

        updateCount();
        showError(getErrorMessage(error));
    } finally {
        if (timeout !== null) {
            clearTimeout(timeout);
        }

        hideLoading();
        state.loading = false;
        setRefreshLoading(false);
    }
}

/* ===================== NORMALIZE API DATA ================ */
function normalizeApiData(result) {
    if (Array.isArray(result)) {
        return result;
    }

    if (result && Array.isArray(result.quizzes)) {
        return result.quizzes;
    }

    if (result && Array.isArray(result.data)) {
        return result.data;
    }

    if (result && Array.isArray(result.items)) {
        return result.items;
    }

    if (result && Array.isArray(result.results)) {
        return result.results;
    }

    if (
        result?.data &&
        Array.isArray(result.data.quizzes)
    ) {
        return result.data.quizzes;
    }

    throw createApiError(
        result?.message ||
        "Dữ liệu API không có danh sách phiên Quiz hợp lệ."
    );
}

/* ===================== NORMALIZE QUIZZES ================= */
function normalizeQuizzes(quizzes) {
    const normalized = [];
    const usedCodes = new Set();

    quizzes.forEach(function(item) {
        if (!item || typeof item !== "object") {
            return;
        }

        const code = String(
            item.code ?? item.quizCode ?? ""
        ).trim();

        if (
            !code ||
            !/^\d+$/.test(code) ||
            usedCodes.has(code)
        ) {
            return;
        }

        usedCodes.add(code);

        normalized.push({
            id: String(item.id ?? "").trim(),

            name: String(
                item.name ||
                item.title ||
                "Quiz"
            ).trim(),

            code,

            description: String(
                item.description ||
                item.desc ||
                ""
            ).trim(),

            startTime:
                item.startTime ??
                item.start_time ??
                item.start ??
                "",

            endTime:
                item.endTime ??
                item.end_time ??
                item.end ??
                ""
        });
    });

    return normalized;
}

/* ====================== QUIZ STATUS ====================== */
function getQuizStatus(quiz) {
    const now = Date.now();

    const startTime = parseQuizTime(quiz.startTime);
    const endTime = parseQuizTime(quiz.endTime);

    if (
        startTime === null ||
        endTime === null ||
        startTime > endTime
    ) {
        return {
            type: "invalid",
            text: "Chưa xác định",
            canPlay: false
        };
    }

    if (now < startTime) {
        return {
            type: "upcoming",
            text: "Chưa mở",
            canPlay: false
        };
    }

    /*
     * QUAN TRỌNG:
     * Khi thời gian hiện tại bằng hoặc lớn hơn endTime,
     * phiên Quiz lập tức được xem là đã đóng.
     * Không phụ thuộc active hoặc status từ API.
     */

    if (now >= endTime) {
        return {
            type: "closed",
            text: "Đã đóng",
            canPlay: false
        };
    }

    return {
        type: "open",
        text: "Đang mở",
        canPlay: true
    };
}

/* ====================== PARSE QUIZ TIME ================== */
function parseQuizTime(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    if (
        typeof value === "number" &&
        Number.isFinite(value)
    ) {
        const timestamp =
            value < 1000000000000
                ? value * 1000
                : value;

        return Number.isFinite(timestamp)
            ? timestamp
            : null;
    }

    /*
     * Chuỗi dạng YYYY-MM-DDTHH:mm:ss không có múi giờ
     * được hiểu theo giờ Việt Nam UTC+07:00.
     *
     * Ví dụ:
     * 2026-11-26T12:00:00
     * = 12 giờ trưa ngày 26/11/2026 tại Việt Nam.
     *
     * Nếu chuỗi đã có Z hoặc độ lệch múi giờ,
     * giữ nguyên múi giờ được cung cấp.
     */

    let dateString = String(value).trim();

    const hasExplicitTimezone =
        /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateString);

    if (
        !hasExplicitTimezone &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(dateString)
    ) {
        dateString += "+07:00";
    }

    const parsed = Date.parse(dateString);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

/* ====================== COUNTDOWN ======================== */
function formatCountdown(milliseconds) {
    if (milliseconds <= 0) {
        return "đang bắt đầu...";
    }

    const totalSeconds = Math.floor(
        milliseconds / 1000
    );

    const days = Math.floor(
        totalSeconds / 86400
    );

    const hours = Math.floor(
        (totalSeconds % 86400) / 3600
    );

    const minutes = Math.floor(
        (totalSeconds % 3600) / 60
    );

    const seconds = totalSeconds % 60;

    const parts = [];

    if (days > 0) {
        parts.push(days + " ngày");
    }

    if (hours > 0) {
        parts.push(hours + " giờ");
    }

    if (minutes > 0) {
        parts.push(minutes + " phút");
    }

    if (days === 0 && seconds > 0) {
        parts.push(seconds + " giây");
    }

    if (parts.length === 0) {
        parts.push("dưới 1 giây");
    }

    return parts.join(" ");
}

/* ============================ FILTER ===================== */
function filterAndRender() {
    const keyword = state.searchText;

    if (!keyword) {
        state.filteredQuizzes = state.quizzes.slice();
    } else {
        state.filteredQuizzes = state.quizzes.filter(function(quiz) {
            const text = [
                quiz.name,
                quiz.code,
                quiz.description
            ].join(" ").toLowerCase();

            return text.includes(keyword);
        });
    }

    /* Sắp xếp theo thời hạn trước khi hiển thị */
    state.filteredQuizzes = sortQuizzesByDeadline(
        state.filteredQuizzes
    );

    renderQuizzes();
    updateCount();
    updateEmptyState();
}

/* ==================== SORT QUIZ BY DEADLINE ==================== */

/*
 * Thứ tự hiển thị:
 * 1. Đang mở: phiên sắp hết hạn trước.
 * 2. Chưa mở: phiên sắp đến giờ bắt đầu trước.
 * 3. Đã đóng: phiên vừa hết hạn trước.
 * 4. Chưa xác định: xếp cuối.
 *
 * Chỉ sắp xếp dữ liệu hiển thị, không thay đổi dữ liệu API.
 */

function sortQuizzesByDeadline(quizzes) {
    function getSortInfo(quiz) {
        const status = getQuizStatus(quiz);

        if (status.type === "open") {
            return {
                priority: 1,
                deadline: parseQuizTime(quiz.endTime) ?? Infinity
            };
        }

        if (status.type === "upcoming") {
            return {
                priority: 2,
                deadline: parseQuizTime(quiz.startTime) ?? Infinity
            };
        }

        if (status.type === "closed") {
            return {
                priority: 3,

                /*
                 * Thời điểm kết thúc càng gần hiện tại
                 * thì phiên vừa đóng càng được ưu tiên.
                 */
                deadline: -(parseQuizTime(quiz.endTime) ?? 0)
            };
        }

        return {
            priority: 4,
            deadline: Infinity
        };
    }

    return quizzes
        .map(function(quiz, index) {
            const sortInfo = getSortInfo(quiz);

            return {
                quiz,
                index,
                priority: sortInfo.priority,
                deadline: sortInfo.deadline
            };
        })
        .sort(function(a, b) {
            return (
                a.priority - b.priority ||
                a.deadline - b.deadline ||
                a.index - b.index
            );
        })
        .map(function(item) {
            return item.quiz;
        });
}

/* ============================ RENDER ===================== */
function renderQuizzes() {
    if (!elements.quizContainer) {
        return;
    }

    elements.quizContainer.innerHTML = "";

    if (state.filteredQuizzes.length === 0) {
        return;
    }

    const fragment = document.createDocumentFragment();

    state.filteredQuizzes.forEach(function(quiz) {
        fragment.appendChild(createQuizCard(quiz));
    });

    elements.quizContainer.appendChild(fragment);
    applyViewMode();
}

/* ======================== CREATE CARD ==================== */
function createQuizCard(quiz) {
    const card = document.createElement("article");
    card.className = "quiz-card";
    card.dataset.code = quiz.code;

    const status = getQuizStatus(quiz);

    const top = document.createElement("div");
    top.className = "quiz-card-top";

    const icon = document.createElement("div");
    icon.className = "quiz-icon";
    icon.innerHTML =
        '<i class="fa-solid fa-graduation-cap"></i>';

    const statusBadge = document.createElement("span");
    statusBadge.className =
        "quiz-status status-" + status.type;
    statusBadge.textContent = status.text;

    top.appendChild(icon);
    top.appendChild(statusBadge);

    const content = document.createElement("div");
    content.className = "quiz-content";

    const title = document.createElement("h3");
    title.className = "quiz-title";
    title.textContent = quiz.name;

    const description = document.createElement("p");
    description.className = "quiz-description";

    if (status.type === "upcoming") {
        const startTime = parseQuizTime(quiz.startTime);

        description.textContent =
            "Vui lòng quay trở lại sau " +
            formatCountdown(startTime - Date.now());
    } else if (status.type === "closed") {
        description.textContent =
            "Phiên Quiz đã kết thúc.";
    } else if (status.type === "open") {
        description.textContent =
            quiz.description ||
            "Phiên Quiz đã sẵn sàng. Em có thể bắt đầu!";
    } else {
        description.textContent =
            "Chưa xác định được thời gian mở phiên Quiz.";
    }

    content.appendChild(title);
    content.appendChild(description);

    if (status.canPlay) {
        const codeElement = document.createElement("div");
        codeElement.className = "quiz-code";
        codeElement.innerHTML =
            '<i class="fa-solid fa-hashtag"></i> ' +
            'Mã phiên: <strong></strong>';

        codeElement.querySelector("strong").textContent =
            quiz.code;

        content.appendChild(codeElement);
    }

    const footer = document.createElement("div");
    footer.className = "quiz-card-footer";

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "play-button";

    if (status.canPlay) {
        playButton.innerHTML =
            '<i class="fa-solid fa-play"></i>' +
            '<span>Chơi ngay</span>';

        playButton.addEventListener(
            "click",
            function() {
                /*
                 * Kiểm tra lại thời gian ngay khi nhấn,
                 * không chỉ dựa vào trạng thái lúc render.
                 */

                const currentStatus = getQuizStatus(quiz);

                if (!currentStatus.canPlay) {
                    showToastMessage(
                        currentStatus.type === "upcoming"
                            ? "Phiên Quiz chưa đến giờ mở."
                            : currentStatus.type === "closed"
                                ? "Phiên Quiz đã hết thời gian."
                                : "Không xác định được thời gian phiên Quiz."
                    );

                    filterAndRender();
                    return;
                }

                openQuiz(quiz.code);
            }
        );
    } else {
        playButton.disabled = true;
        playButton.classList.add("disabled");
        playButton.innerHTML =
            '<i class="fa-solid fa-lock"></i>' +
            '<span></span>';

        playButton.querySelector("span").textContent =
            status.text;
    }

    footer.appendChild(playButton);
    card.appendChild(top);
    card.appendChild(content);
    card.appendChild(footer);

    return card;
}

/* =========================== OPEN QUIZ =================== */
function openQuiz(code) {
    const cleanCode = String(code || "").trim();

    if (!/^\d+$/.test(cleanCode)) {
        showToastMessage("Mã phiên không hợp lệ.");
        return;
    }

    const target =
        "running/index.html?code=" +
        encodeURIComponent(cleanCode);

    const newTab = window.open(target, "_blank");

    if (!newTab) {
        showToastMessage(
            "Trình duyệt đã chặn cửa sổ mới. " +
            "Hãy cho phép mở tab."
        );
        return;
    }

    try {
        newTab.opener = null;
    } catch (error) {
        // Không ảnh hưởng đến việc mở phiên Quiz.
    }
}

/* ========================== VIEW MODE ==================== */
function loadSavedViewMode() {
    try {
        return localStorage.getItem(CONFIG.STORAGE_VIEW) === "list"
            ? "list"
            : "grid";
    } catch (error) {
        return "grid";
    }
}

function setViewMode(mode) {
    if (mode !== "grid" && mode !== "list") {
        return;
    }

    state.viewMode = mode;

    try {
        localStorage.setItem(CONFIG.STORAGE_VIEW, mode);
    } catch (error) {
        console.warn(
            "Không thể lưu chế độ xem:",
            error
        );
    }

    applyViewMode();
}

function applyViewMode() {
    if (!elements.quizContainer) {
        return;
    }

    elements.quizContainer.classList.toggle(
        "list-view",
        state.viewMode === "list"
    );

    if (elements.gridViewButton) {
        elements.gridViewButton.classList.toggle(
            "active",
            state.viewMode === "grid"
        );
    }

    if (elements.listViewButton) {
        elements.listViewButton.classList.toggle(
            "active",
            state.viewMode === "list"
        );
    }
}

/* ============================ SEARCH ===================== */
function clearSearch() {
    state.searchText = "";

    if (elements.searchInput) {
        elements.searchInput.value = "";
    }

    updateSearchButton();
    filterAndRender();
}

function updateSearchButton() {
    if (elements.clearSearch) {
        elements.clearSearch.classList.toggle(
            "hidden",
            !state.searchText
        );
    }
}

/* ============================ COUNT ====================== */
function updateCount() {
    if (!elements.quizCount) {
        return;
    }

    const total = state.quizzes.length;
    const visible = state.filteredQuizzes.length;

    elements.quizCount.textContent =
        state.searchText
            ? visible + " / " + total + " phiên"
            : total + " phiên";
}

/* ========================= EMPTY STATE =================== */
function updateEmptyState() {
    if (!state.quizzes.length) {
        showEmpty(
            "Hiện chưa có phiên Quiz nào được mở."
        );
        return;
    }

    if (!state.filteredQuizzes.length) {
        showEmpty(
            "Không tìm thấy phiên Quiz phù hợp."
        );
        return;
    }

    hideEmpty();
}

/* ============================ STATES ===================== */
function showLoading() {
    if (elements.loadingState) {
        elements.loadingState.classList.remove("hidden");
    }

    hideError();
    hideEmpty();
}

function hideLoading() {
    if (elements.loadingState) {
        elements.loadingState.classList.add("hidden");
    }
}

function showEmpty(message) {
    hideLoading();
    hideError();

    if (elements.emptyMessage) {
        elements.emptyMessage.textContent = message;
    }

    if (elements.emptyState) {
        elements.emptyState.classList.remove("hidden");
    }
}

function hideEmpty() {
    if (elements.emptyState) {
        elements.emptyState.classList.add("hidden");
    }
}

/* ============================== ERROR =================== */
function showError(message) {
    if (elements.errorMessage) {
        elements.errorMessage.textContent =
            message || "Không thể tải dữ liệu.";
    }

    if (elements.errorState) {
        elements.errorState.classList.remove("hidden");
    }

    showDeviceIdInError();

    if (elements.quizContainer) {
        elements.quizContainer.innerHTML = "";
    }

    if (elements.emptyState) {
        elements.emptyState.classList.add("hidden");
    }
}

function showDeviceIdInError() {
    if (!elements.errorState) {
        return;
    }

    let deviceIdLine =
        document.getElementById("deviceIdErrorLine");

    if (!deviceIdLine) {
        deviceIdLine = document.createElement("div");
        deviceIdLine.id = "deviceIdErrorLine";

        Object.assign(deviceIdLine.style, {
            display: "block",
            marginTop: "8px",
            fontSize: "13px",
            lineHeight: "1.6",
            color: "#64748b",
            overflowWrap: "anywhere",
            userSelect: "text"
        });

        if (
            elements.errorMessage &&
            elements.errorMessage.parentNode
        ) {
            elements.errorMessage.insertAdjacentElement(
                "afterend",
                deviceIdLine
            );
        } else {
            elements.errorState.appendChild(deviceIdLine);
        }
    }

    let deviceId = "";

    try {
        deviceId = String(
            localStorage.getItem(CONFIG.STORAGE_DEVICE_ID) || ""
        ).trim();
    } catch (error) {
        console.warn(
            "Không thể đọc ID thiết bị:",
            error
        );
    }

    deviceIdLine.textContent = deviceId
        ? "ID thiết bị: " + deviceId
        : "ID thiết bị: Chưa có hoặc chưa lưu được";
}

function hideError() {
    if (elements.errorState) {
        elements.errorState.classList.add("hidden");
    }
}

/* ======================= ERROR MESSAGE =================== */
function getErrorMessage(error) {
    if (error?.name === "AbortError") {
        return "API không phản hồi. Vui lòng thử lại.";
    }

    const deviceErrorCodes = [
        "DEVICE_LOCKED",
        "DEVICE_UNREGISTERED",
        "DEVICE_NOT_FOUND",
        "DEVICE_ID_MISSING",
        "DEVICE_EXPIRED",
        "TOKEN_INVALID",
        "TOKEN_MISSING",
        "DEVICE_TOKEN_MISSING",
        "IP_NOT_FOUND",
        "IP_MISSING"
    ];

    if (deviceErrorCodes.includes(error?.code)) {
        return error.message;
    }

    return (
        error?.message ||
        "Không thể kết nối tới API."
    );
}

/* ======================== REFRESH BUTTON ================ */
function setRefreshLoading(loading) {
    if (elements.refreshButton) {
        elements.refreshButton.disabled = loading;

        const icon =
            elements.refreshButton.querySelector("i");

        if (icon) {
            icon.classList.toggle("fa-spin", loading);
        }
    }

    if (elements.retryButton) {
        elements.retryButton.disabled = loading;
    }
}

/* ============================== TOAST ==================== */
let toastTimer = null;

function showToastMessage(message) {
    if (
        !elements.toast ||
        !elements.toastMessage
    ) {
        return;
    }

    elements.toastMessage.textContent = message;
    elements.toast.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(function() {
        elements.toast.classList.remove("show");
    }, 3000);
}

/* ============================ KEYBOARD ================== */
function handleKeyboard(event) {
    if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k"
    ) {
        event.preventDefault();

        if (elements.searchInput) {
            elements.searchInput.focus();
        }
    }

    if (
        event.key === "Escape" &&
        state.searchText
    ) {
        clearSearch();
    }
}

/* ===================== AUTO UPDATE STATUS ================ */

/*
 * Cập nhật trạng thái mỗi giây.
 * Không gọi API mỗi giây.
 *
 * Khi thời gian thay đổi:
 * - Cập nhật trạng thái mở/đóng của từng Quiz.
 * - Tự động sắp xếp lại theo thời hạn.
 * - Khóa nút chơi khi phiên Quiz đã hết giờ.
 */

setInterval(function() {
    if (
        !state.loading &&
        state.quizzes.length > 0
    ) {
        filterAndRender();
    }
}, 1000);
