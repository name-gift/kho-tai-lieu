
"use strict";

/* =====================================================
   ADMIN DASHBOARD — KHO TÀI LIỆU / KHO QUIZ

   - Không tự động gọi API theo chu kỳ.
   - Tải dữ liệu khi mở trang hoặc khi người dùng yêu cầu.
   - Dùng các action admin_* của Google Apps Script.
   - Không hiển thị thành công nếu API báo thất bại.
===================================================== */

/* ==================== CẤU HÌNH ==================== */

const DEFAULT_WORKER =
    "https://api-tai-lieu.abcd1601ab.workers.dev";

const DEFAULT_GAS =
    "https://script.google.com/macros/s/AKfycbyq2uML6wFa2isEX5BLffLjXKxMKVeT0EpdAKk0v4oJJinsTpEVvEtLRzZ0R3ZPtLMY/exec";

const STORAGE_KEYS = {
    worker: "admin_worker_url",
    gas: "admin_gas_url",
    key: "admin_key",
    deviceId: "kho_tai_lieu_device_id_v1"
};

const $ = id => document.getElementById(id);

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
}[char]));

function inlineArg(value) {
    // An toàn khi nhúng chuỗi JSON vào thuộc tính onclick.
    return esc(JSON.stringify(String(value ?? "")));
}

function val(object, ...keys) {
    for (const key of keys) {
        if (
            object?.[key] !== undefined &&
            object[key] !== null &&
            object[key] !== ""
        ) {
            return object[key];
        }
    }

    return "";
}

function boolValue(value) {
    if (value === true || value === 1) return true;

    const normalized = String(value ?? "").trim().toLowerCase();

    return [
        "true", "1", "yes", "on", "active", "enabled",
        "open", "đang mở", "đang hoạt động"
    ].includes(normalized);
}

function deviceIdForError() {
    try {
        return (
            localStorage.getItem(STORAGE_KEYS.deviceId) ||
            localStorage.getItem("deviceId") ||
            "Không tìm thấy deviceId trong localStorage"
        );
    } catch {
        return "Không thể đọc deviceId từ localStorage";
    }
}

function errorWithDeviceId(message) {
    return String(message || "Lỗi không xác định") +
        "\n\nDevice ID trên trình duyệt: " + deviceIdForError();
}

/* ==================== TRẠNG THÁI ==================== */

let config = {
    worker: DEFAULT_WORKER,
    gas: DEFAULT_GAS,
    key: ""
};

let files = [];
let quizzes = [];
let devices = [];

let modalState = null;
let loadingAll = false;
let loadingDevices = false;
let deviceLoadTime = null;
let noticeTimer = null;

try {
    config.worker = localStorage.getItem(STORAGE_KEYS.worker) || DEFAULT_WORKER;
    config.gas = localStorage.getItem(STORAGE_KEYS.gas) || DEFAULT_GAS;
    config.key = localStorage.getItem(STORAGE_KEYS.key) || "";
} catch (error) {
    console.warn("Không đọc được cấu hình lưu trên trình duyệt:", error);
}

/* ==================== THÔNG BÁO ==================== */

function showNotice(message, type = "info") {
    const notice = $("notice");
    if (!notice) return;

    const title = notice.querySelector(".notice-title");
    const content = notice.querySelector(".notice-message");
    const icon = notice.querySelector(".notice-icon i");

    const titles = {
        success: "Thành công",
        error: "Có lỗi xảy ra",
        info: "Thông báo",
        warning: "Cần chú ý"
    };

    const icons = {
        success: "fa-solid fa-circle-check",
        error: "fa-solid fa-circle-exclamation",
        warning: "fa-solid fa-triangle-exclamation",
        info: "fa-solid fa-circle-info"
    };

    if (title) title.textContent = titles[type] || titles.info;
    if (content) content.textContent = String(message ?? "");
    if (icon) icon.className = icons[type] || icons.info;

    notice.className = "notice show " + type;

    if (noticeTimer) clearTimeout(noticeTimer);

    noticeTimer = setTimeout(() => {
        notice.classList.remove("show", "active");
    }, 6500);
}

function setConnectionText(message, state = "normal") {
    const text = $("connectionText");
    if (text) text.textContent = message;

    const dot = document.querySelector(".connection-status .status-dot");

    if (dot) {
        dot.classList.toggle("is-error", state === "error");
        dot.classList.toggle("is-loading", state === "loading");
    }
}

/* ==================== ĐIỀU HƯỚNG ==================== */

function toggleSidebar(open) {
    $("sidebar")?.classList.toggle("open", Boolean(open));
    $("shade")?.classList.toggle("show", Boolean(open));
}

function navigate(page) {
    const allowedPages = ["dashboard", "files", "quizzes", "devices", "settings"];

    if (!allowedPages.includes(page)) return;

    document.querySelectorAll(".page-section").forEach(section => {
        section.classList.toggle("active", section.id === "page-" + page);
    });

    document.querySelectorAll(".sidebar-nav .nav-item").forEach(button => {
        button.classList.toggle("active", button.dataset.page === page);
    });

    const titles = {
        dashboard: "Tổng quan",
        files: "Quản lý tài liệu",
        quizzes: "Quản lý Quiz",
        devices: "Quản lý thiết bị",
        settings: "Cài đặt API"
    };

    if ($("pageTitle")) {
        $("pageTitle").textContent = titles[page];
    }

    toggleSidebar(false);

    // Chuyển trang chỉ render dữ liệu đã tải, không tự gọi API.
    if (page === "files") renderFiles();
    if (page === "quizzes") renderQuizzes();
    if (page === "devices") renderDevices();

    if (page === "dashboard") {
        renderStats();
        renderRecent();
    }

    if (page === "settings") initSettings();
}

/* ==================== CÀI ĐẶT ==================== */

function initSettings() {
    if ($("workerUrl")) $("workerUrl").value = config.worker;
    if ($("gasUrl")) $("gasUrl").value = config.gas;
    if ($("adminKey")) $("adminKey").value = config.key;
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:";
    } catch {
        return false;
    }
}

function saveSettings() {
    const workerInput = $("workerUrl")?.value.trim() || "";
    const gasInput = $("gasUrl")?.value.trim() || "";
    const keyInput = $("adminKey")?.value.trim() || "";

    const worker = (workerInput || DEFAULT_WORKER).replace(/\/+$/, "");
    const gas = gasInput || DEFAULT_GAS;

    if (!isHttpUrl(worker)) {
        showNotice("Worker URL không hợp lệ. Hãy kiểm tra lại địa chỉ.", "error");
        return;
    }

    if (!isHttpUrl(gas)) {
        showNotice("Google Apps Script URL không hợp lệ.", "error");
        return;
    }

    try {
        localStorage.setItem(STORAGE_KEYS.worker, worker);
        localStorage.setItem(STORAGE_KEYS.gas, gas);
        localStorage.setItem(STORAGE_KEYS.key, keyInput);
    } catch (error) {
        showNotice(
            "Không lưu được cấu hình trên trình duyệt. Hãy kiểm tra quyền lưu trữ.",
            "error"
        );
        return;
    }

    config.worker = worker;
    config.gas = gas;
    config.key = keyInput;

    showNotice("Đã lưu cấu hình trên trình duyệt này.", "success");

    // Chủ động kiểm tra dữ liệu sau khi người dùng lưu cấu hình.
    loadAll();
}

/* ==================== GỌI API ==================== */

async function request(url, timeout = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            headers: {
                Accept: "application/json"
            }
        });

        const responseText = await response.text();

        let result;

        try {
            result = JSON.parse(responseText);
        } catch {
            throw new Error(
                "API không trả JSON hợp lệ. Hãy kiểm tra URL Apps Script, " +
                "quyền triển khai Web App và phản hồi từ máy chủ."
            );
        }

        if (!response.ok) {
            throw new Error(
                result?.message ||
                result?.error ||
                "HTTP " + response.status
            );
        }

        return result;
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("API phản hồi quá thời gian chờ 20 giây.");
        }

        if (error instanceof TypeError) {
            throw new Error(
                "Không thể kết nối API. Kiểm tra kết nối mạng, URL và quyền truy cập."
            );
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function dataArray(result) {
    if (Array.isArray(result)) return result;

    for (const key of [
        "data", "items", "files", "quizzes", "devices", "results"
    ]) {
        if (Array.isArray(result?.[key])) return result[key];
    }

    return [];
}

function assertApiSuccess(result) {
    if (result?.success === false || result?.ok === false) {
        throw new Error(
            result.message ||
            result.error ||
            result.code ||
            "API từ chối yêu cầu quản trị."
        );
    }

    return result;
}

function makeApiUrl(action, params = {}) {
    if (!config.gas) {
        throw new Error("Chưa cấu hình Google Apps Script URL.");
    }

    if (!isHttpUrl(config.gas)) {
        throw new Error("Google Apps Script URL không hợp lệ.");
    }

    const url = new URL(config.gas);
    url.searchParams.set("action", action);
    url.searchParams.set("_", String(Date.now()));

    if (config.key) {
        url.searchParams.set("adminKey", config.key);
    }

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, String(value));
        }
    }

    return url.toString();
}

async function fetchEndpoint(action) {
    const result = await request(makeApiUrl(action));
    return assertApiSuccess(result);
}

/* ==================== TẢI DỮ LIỆU ==================== */

async function loadAll() {
    if (loadingAll) {
        showNotice("Đang tải dữ liệu, vui lòng chờ.", "info");
        return;
    }

    loadingAll = true;
    setConnectionText("Đang kết nối API...", "loading");

    const results = await Promise.allSettled([
        fetchEndpoint("admin_files"),
        fetchEndpoint("admin_quizzes"),
        fetchEndpoint("admin_devices")
    ]);

    let successCount = 0;
    const errors = [];

    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            successCount++;

            const list = dataArray(result.value);

            if (index === 0) files = list;
            if (index === 1) quizzes = list;

            if (index === 2) {
                devices = list;
                deviceLoadTime = Date.now();
            }
        } else {
            const message =
                result.reason?.message || "Lỗi không xác định";

            errors.push(message);
            console.error("Admin API lỗi:", message);
        }
    });

    loadingAll = false;
    renderAll();

    if (successCount === 3) {
        setConnectionText("Đã kết nối đủ 3 API");
        showNotice("Đã tải dữ liệu từ cả 3 API quản trị.", "success");
        return;
    }

    if (successCount > 0) {
        setConnectionText("Tải được " + successCount + "/3 API", "error");

        showNotice(
            "Một số API chưa tải được dữ liệu (" + successCount + "/3).\n\n" +
            errors.join("\n"),
            "warning"
        );
        return;
    }

    setConnectionText("Không kết nối được Admin API", "error");

    showNotice(
        "Không tải được dữ liệu quản trị.\n\n" +
        errors.join("\n") +
        "\n\nKiểm tra URL Apps Script, Admin Key và quyền triển khai.",
        "error"
    );
}

async function loadDevices() {
    if (loadingDevices) return;

    loadingDevices = true;
    setConnectionText("Đang tải thiết bị...", "loading");

    try {
        const result = await fetchEndpoint("admin_devices");

        devices = dataArray(result);
        deviceLoadTime = Date.now();

        renderDevices();
        renderStats();
        renderRecent();

        setConnectionText("Đã cập nhật thiết bị");
        showNotice("Đã cập nhật danh sách thiết bị.", "success");
    } catch (error) {
        setConnectionText("Lỗi tải thiết bị", "error");

        showNotice(
            "Không tải được danh sách thiết bị.\n\n" + error.message,
            "error"
        );
    } finally {
        loadingDevices = false;
    }
}

function refreshCurrent() {
    const activePage = document.querySelector(".page-section.active")?.id;

    if (activePage === "page-devices") {
        loadDevices();
    } else {
        loadAll();
    }
}

function renderAll() {
    renderFiles();
    renderQuizzes();
    renderDevices();
    renderStats();
    renderRecent();
}

/* ==================== TRẠNG THÁI ==================== */

function normalizeStatus(status) {
    const value = String(status ?? "").trim().toLowerCase();

    if ([
        "active", "enabled", "unlocked", "đang hoạt động",
        "đang mở", "open", "true"
    ].includes(value)) return "active";

    if ([
        "locked", "blocked", "đã khóa", "bị khóa"
    ].includes(value)) return "locked";

    if ([
        "expired", "hết hạn"
    ].includes(value)) return "expired";

    if ([
        "inactive", "disabled", "đang tắt", "false", "0"
    ].includes(value)) return "inactive";

    if (["upcoming", "pending", "chưa mở"].includes(value)) return "upcoming";
    if (["closed", "đã đóng"].includes(value)) return "closed";

    return value || "unknown";
}

function deviceStatus(device) {
    if (boolValue(device?.locked)) return "locked";
    if (boolValue(device?.expired)) return "expired";
    return normalizeStatus(val(device, "status", "state"));
}

function statusBadge(status) {
    const normalized = normalizeStatus(status);

    const classes = {
        active: "active",
        open: "active",
        locked: "locked",
        closed: "locked",
        inactive: "locked",
        expired: "pending",
        upcoming: "pending",
        pending: "pending"
    };

    const labels = {
        active: "Đang hoạt động",
        locked: "Đã khóa",
        expired: "Hết hạn",
        open: "Đang mở",
        upcoming: "Chưa mở",
        closed: "Đã đóng",
        inactive: "Không hoạt động",
        pending: "Đang chờ",
        unknown: "Không rõ"
    };

    return `<span class="badge ${classes[normalized] || "neutral"}">${
        esc(labels[normalized] || status || "Không rõ")
    }</span>`;
}

function isFileInactive(file) {
    const raw = val(file, "isActive", "active", "status");

    if (raw === "") return false;

    return [
        "false", "0", "no", "inactive", "disabled",
        "locked", "không hoạt động"
    ].includes(String(raw).trim().toLowerCase());
}

/* ==================== THỐNG KÊ ==================== */

function renderStats() {
    if ($("statFiles")) $("statFiles").textContent = files.length;
    if ($("statQuizzes")) $("statQuizzes").textContent = quizzes.length;

    if ($("statActive")) {
        $("statActive").textContent = devices.filter(device =>
            deviceStatus(device) === "active"
        ).length;
    }

    if ($("statLocked")) {
        $("statLocked").textContent = devices.filter(device =>
            deviceStatus(device) === "locked"
        ).length;
    }
}

/* ==================== TÀI LIỆU ==================== */

function renderFiles() {
    if (!$("filesBody")) return;

    const query = ($("fileSearch")?.value || "").trim().toLowerCase();
    const status = $("fileStatus")?.value || "";

    const rows = files.filter(file => {
        const matchesQuery = JSON.stringify(file).toLowerCase().includes(query);
        const inactive = isFileInactive(file);

        const matchesStatus =
            !status ||
            (status === "active" && !inactive) ||
            (status === "inactive" && inactive);

        return matchesQuery && matchesStatus;
    });

    $("filesBody").innerHTML = rows.length
        ? rows.map(file => {
            const id = val(file, "id", "fileId");
            const name = val(file, "name", "title", "fileName") || "Chưa có tên";
            const category = val(file, "folder", "category", "type") || "—";
            const description = val(file, "description", "desc");

            return `
                <tr>
                    <td>
                        <strong>${esc(name)}</strong>
                        <div class="sub">${esc(description)}</div>
                    </td>
                    <td>${esc(id || "—")}</td>
                    <td>${esc(category)}</td>
                    <td>${statusBadge(isFileInactive(file) ? "inactive" : "active")}</td>
                    <td>
                        <div class="actions">
                            <button class="mini" type="button"
                                title="Xem chi tiết"
                                aria-label="Xem chi tiết tài liệu"
                                onclick="viewItem('file', ${inlineArg(id)})">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                            <button class="mini" type="button"
                                title="Sao chép ID"
                                aria-label="Sao chép ID tài liệu"
                                onclick="copyText(${inlineArg(id)})">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join("")
        : `<tr><td colspan="5" class="empty-cell">
            <i class="fa-regular fa-folder-open"></i>
            ${files.length
                ? "Không tìm thấy tài liệu phù hợp."
                : "Chưa có dữ liệu tài liệu."}
        </td></tr>`;

    if ($("filesCount")) {
        $("filesCount").textContent = `${rows.length} / ${files.length}`;
    }
}

/* ==================== QUIZ ==================== */

function quizState(quiz) {
    const rawStatus = String(val(quiz, "status", "state")).trim().toLowerCase();

    if (["open", "active", "đang mở"].includes(rawStatus)) return "active";
    if (["upcoming", "pending", "chưa mở"].includes(rawStatus)) return "upcoming";
    if (["closed", "inactive", "đã đóng"].includes(rawStatus)) return "closed";

    const startRaw = val(quiz, "startTime", "start", "startDate", "startAt");
    const endRaw = val(quiz, "endTime", "end", "endDate", "endAt");

    const start = Date.parse(startRaw || "") || 0;
    const end = Date.parse(endRaw || "") || 0;
    const now = Date.now();

    if (start && now < start) return "upcoming";
    if (end && now > end) return "closed";

    return "active";
}

function renderQuizzes() {
    if (!$("quizzesBody")) return;

    const query = ($("quizSearch")?.value || "").trim().toLowerCase();
    const status = $("quizStatus")?.value || "";

    const rows = quizzes.filter(quiz => {
        const matchesQuery = JSON.stringify(quiz).toLowerCase().includes(query);
        const state = quizState(quiz);

        const matchesStatus =
            !status ||
            (status === "active" && state === "active") ||
            (status === "upcoming" && state === "upcoming") ||
            (status === "closed" && state === "closed");

        return matchesQuery && matchesStatus;
    });

    $("quizzesBody").innerHTML = rows.length
        ? rows.map(quiz => {
            const id = val(quiz, "id", "code", "quizCode");
            const code = val(quiz, "code", "quizCode", "gc") || "—";
            const name = val(quiz, "name", "title") || "Chưa có tên";
            const count = val(
                quiz,
                "questionCount",
                "questionsCount",
                "totalQuestions",
                "question_count",
                "count"
            );

            const state = quizState(quiz);

            return `
                <tr>
                    <td>
                        <strong>${esc(name)}</strong>
                        <div class="sub">${esc(val(quiz, "desc", "description"))}</div>
                    </td>
                    <td><strong>${esc(code)}</strong></td>
                    <td>${esc(count || "—")}</td>
                    <td>${statusBadge(state)}</td>
                    <td>
                        <div class="actions">
                            <button class="mini" type="button"
                                title="Xem chi tiết"
                                aria-label="Xem chi tiết Quiz"
                                onclick="viewItem('quiz', ${inlineArg(id)})">
                                <i class="fa-regular fa-eye"></i>
                            </button>
                            <button class="mini" type="button"
                                title="Sao chép mã"
                                aria-label="Sao chép mã Quiz"
                                onclick="copyText(${inlineArg(code)})">
                                <i class="fa-regular fa-copy"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join("")
        : `<tr><td colspan="5" class="empty-cell">
            <i class="fa-solid fa-graduation-cap"></i>
            ${quizzes.length
                ? "Không tìm thấy Quiz phù hợp."
                : "Chưa có dữ liệu Quiz."}
        </td></tr>`;

    if ($("quizzesCount")) {
        $("quizzesCount").textContent = `${rows.length} / ${quizzes.length}`;
    }
}

/* ==================== THIẾT BỊ ==================== */

function formatDate(value) {
    if (!value) return "—";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    }).format(date);
}

function relativeTime(value) {
    if (!value) return "Chưa có dữ liệu";

    const timestamp = new Date(value).getTime();

    if (Number.isNaN(timestamp)) return String(value);

    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));

    if (seconds < 5) return "Vừa xong";
    if (seconds < 60) return seconds + " giây trước";

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + " phút trước";

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " giờ trước";

    const days = Math.floor(hours / 24);
    if (days < 30) return days + " ngày trước";

    return formatDate(value);
}

function renderDevices() {
    if (!$("devicesBody")) return;

    const query = ($("deviceSearch")?.value || "").trim().toLowerCase();
    const status = ($("deviceStatus")?.value || "").toLowerCase();

    const rows = devices.filter(device => {
        const matchesQuery = JSON.stringify(device).toLowerCase().includes(query);
        const state = deviceStatus(device);

        const matchesStatus =
            !status ||
            (status === "active" && state === "active") ||
            (status === "locked" && state === "locked") ||
            (status === "expired" && state === "expired");

        return matchesQuery && matchesStatus;
    });

    $("devicesBody").innerHTML = rows.length
        ? rows.map(device => {
            const id = val(device, "deviceId", "id") || "";
            const ip = val(device, "ip", "lastIP", "ipAddress") || "—";
            const state = deviceStatus(device);
            const lastSeen = val(device, "lastSeen", "updatedAt", "lastActive");
            const locked = state === "locked";

            return `
                <tr>
                    <td>
                        <strong>${esc(id || "—")}</strong>
                        <div class="sub">Tạo: ${esc(formatDate(
                            val(device, "createdAt", "created_at")
                        ))}</div>
                    </td>
                    <td>${esc(ip)}</td>
                    <td>${statusBadge(state)}</td>
                    <td>
                        <span data-live-time="${esc(lastSeen)}"
                              title="${esc(formatDate(lastSeen))}">
                            ${esc(relativeTime(lastSeen))}
                        </span>
                    </td>
                    <td>
                        <div class="actions">
                            <button class="mini" type="button"
                                title="Xem chi tiết"
                                aria-label="Xem chi tiết thiết bị"
                                onclick="viewItem('device', ${inlineArg(id)})">
                                <i class="fa-regular fa-eye"></i>
                            </button>

                            <button class="mini" type="button"
                                title="Sao chép Device ID"
                                aria-label="Sao chép Device ID"
                                onclick="copyText(${inlineArg(id)})">
                                <i class="fa-regular fa-copy"></i>
                            </button>

                            <button class="mini ${locked ? "success" : "danger"}"
                                type="button"
                                title="${locked ? "Mở khóa" : "Khóa"} thiết bị"
                                aria-label="${locked ? "Mở khóa" : "Khóa"} thiết bị"
                                onclick="${locked ? "confirmUnlock" : "confirmLock"}(${inlineArg(id)})">
                                <i class="fa-solid ${locked ? "fa-lock-open" : "fa-lock"}"></i>
                            </button>

                            <button class="mini danger" type="button"
                                title="Xóa thiết bị"
                                aria-label="Xóa thiết bị"
                                onclick="confirmDeleteDevice(${inlineArg(id)})">
                                <i class="fa-regular fa-trash-can"></i>
                            </button>
                        </div>
                    </td>
                </tr>`;
        }).join("")
        : `<tr><td colspan="5" class="empty-cell">
            <i class="fa-solid fa-mobile-screen-button"></i>
            ${devices.length
                ? "Không tìm thấy thiết bị phù hợp."
                : "Chưa có dữ liệu thiết bị."}
        </td></tr>`;

    if ($("devicesCount")) {
        $("devicesCount").textContent = `${rows.length} / ${devices.length}`;
    }
}

function renderRecent() {
    if (!$("recentBody")) return;

    const recent = [...devices]
        .sort((a, b) => {
            const aTime = Date.parse(val(a, "lastSeen", "updatedAt", "lastActive")) || 0;
            const bTime = Date.parse(val(b, "lastSeen", "updatedAt", "lastActive")) || 0;
            return bTime - aTime;
        })
        .slice(0, 5);

    $("recentBody").innerHTML = recent.length
        ? recent.map(device => `
            <tr>
                <td>
                    <strong>${esc(val(device, "deviceId", "id") || "—")}</strong>
                </td>
                <td>${esc(val(device, "ip", "lastIP", "ipAddress") || "—")}</td>
                <td>${statusBadge(deviceStatus(device))}</td>
            </tr>
        `).join("")
        : `<tr><td colspan="3" class="empty-cell">
            Chưa có thiết bị để hiển thị.
        </td></tr>`;
}

function updateLiveTimes() {
    document.querySelectorAll("[data-live-time]").forEach(element => {
        const value = element.getAttribute("data-live-time");
        element.textContent = relativeTime(value);
        element.title = formatDate(value);
    });
}

/* ==================== MODAL ==================== */

function openModal(title, body, primary = "Xác nhận", action = null) {
    modalState = action;

    if ($("modalTitle")) $("modalTitle").textContent = title;
    if ($("modalBody")) $("modalBody").innerHTML = body;

    const button = $("modalPrimary");

    if (button) {
        button.innerHTML = `<i class="fa-solid fa-check"></i> ${esc(primary)}`;
        button.style.display = action ? "inline-flex" : "none";
        button.disabled = false;
    }

    $("modalBackdrop")?.classList.add("show");
    $("modalBackdrop")?.setAttribute("aria-hidden", "false");
}

function closeModal() {
    $("modalBackdrop")?.classList.remove("show");
    $("modalBackdrop")?.setAttribute("aria-hidden", "true");
    modalState = null;
}

async function modalAction() {
    if (typeof modalState !== "function") return;

    const action = modalState;
    const button = $("modalPrimary");

    if (button) button.disabled = true;

    try {
        await action();
    } catch (error) {
        console.error("Lỗi thao tác trong modal:", error);
        showNotice(error.message || "Thao tác thất bại.", "error");
    } finally {
        if (button) button.disabled = false;
    }
}

function viewItem(type, id) {
    const list = type === "file"
        ? files
        : type === "quiz"
            ? quizzes
            : devices;

    const item = list.find(value => {
        const itemId = type === "device"
            ? val(value, "deviceId", "id")
            : type === "quiz"
                ? val(value, "id", "code", "quizCode")
                : val(value, "id", "fileId");

        return String(itemId) === String(id);
    });

    if (!item) {
        showNotice("Không tìm thấy dữ liệu cần xem.", "error");
        return;
    }

    const body = Object.entries(item)
        .filter(([key]) => !key.toLowerCase().includes("token"))
        .map(([key, value]) => {
            const displayValue = typeof value === "object" && value !== null
                ? JSON.stringify(value, null, 2)
                : String(value ?? "—");

            return `
                <div style="padding:10px 0;border-bottom:1px solid #edf0f5">
                    <div style="font-size:10px;color:#8a94a8;margin-bottom:4px">
                        ${esc(key)}
                    </div>
                    <div style="font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap">
                        ${esc(displayValue)}
                    </div>
                </div>`;
        }).join("");

    openModal(
        "Chi tiết " + ({
            file: "tài liệu",
            quiz: "Quiz",
            device: "thiết bị"
        }[type] || "dữ liệu"),
        body || "<p>Không có thông tin chi tiết.</p>",
        "Đóng",
        null
    );
}

/* ==================== API THAO TÁC ADMIN ==================== */

async function adminAction(action, data = {}) {
    const allowedActions = [
        "lock_device",
        "unlock_device",
        "delete_device",
        "add_file",
        "add_quiz"
    ];

    if (!allowedActions.includes(action)) {
        throw new Error("Thao tác không được hỗ trợ: " + action);
    }

    const params = { ...data };

    // Các action quản trị trong Apps Script có tiền tố admin_.
    const result = await request(
        makeApiUrl("admin_" + action, params)
    );

    assertApiSuccess(result);

    // Một số backend có thể trả success:false hoặc lỗi trong error/code.
    if (
        result?.success !== true &&
        result?.ok !== true &&
        result?.error
    ) {
        throw new Error(result.message || result.error);
    }

    return result;
}

function confirmLock(id) {
    if (!id) {
        showNotice("Không tìm thấy Device ID.", "error");
        return;
    }

    openModal(
        "Khóa thiết bị?",
        `<p>Em có chắc muốn khóa thiết bị <strong>${esc(id)}</strong> không?</p>
         <p>Thiết bị có thể mất quyền truy cập sau khi thao tác được máy chủ chấp nhận.</p>`,
        "Khóa thiết bị",
        async () => {
            const result = await adminAction("lock_device", { deviceId: id });

            closeModal();
            showNotice(
                result.message || "API đã chấp nhận yêu cầu khóa thiết bị.",
                "success"
            );

            await loadDevices();
        }
    );
}

function confirmUnlock(id) {
    if (!id) {
        showNotice("Không tìm thấy Device ID.", "error");
        return;
    }

    openModal(
        "Mở khóa thiết bị?",
        `<p>Em có chắc muốn mở khóa thiết bị <strong>${esc(id)}</strong> không?</p>`,
        "Mở khóa",
        async () => {
            const result = await adminAction("unlock_device", { deviceId: id });

            closeModal();
            showNotice(
                result.message || "API đã chấp nhận yêu cầu mở khóa thiết bị.",
                "success"
            );

            await loadDevices();
        }
    );
}

function confirmDeleteDevice(id) {
    if (!id) {
        showNotice("Không tìm thấy Device ID.", "error");
        return;
    }

    openModal(
        "Xóa thiết bị?",
        `<p>Em sắp xóa thiết bị <strong>${esc(id)}</strong>.</p>
         <p>Thao tác này có thể không hoàn tác được.</p>`,
        "Xóa thiết bị",
        async () => {
            const result = await adminAction("delete_device", { deviceId: id });

            closeModal();
            showNotice(
                result.message || "API đã chấp nhận yêu cầu xóa thiết bị.",
                "success"
            );

            await loadDevices();
        }
    );
}

/* ==================== THÊM TÀI LIỆU / QUIZ ==================== */

function openItemModal(type) {
    if (type !== "file" && type !== "quiz") {
        showNotice("Loại dữ liệu không hợp lệ.", "error");
        return;
    }

    const isFile = type === "file";

    openModal(
        isFile ? "Thêm tài liệu" : "Thêm Quiz",
        `
            <div class="form-group">
                <label for="newName">Tên ${isFile ? "tài liệu" : "Quiz"}</label>
                <input id="newName" type="text"
                    maxlength="250"
                    placeholder="Nhập tên..."
                    autocomplete="off"
                    required>
            </div>

            <div class="form-group">
                <label for="newCode">${isFile ? "ID tài liệu" : "Mã tham gia Quiz"}</label>
                <input id="newCode" type="text"
                    maxlength="100"
                    placeholder="${isFile ? "Nhập ID dạng số..." : "Nhập mã tham gia..."}"
                    autocomplete="off"
                    required>
                <small>
                    ${isFile
                        ? "ID tài liệu cần đúng định dạng mà Apps Script yêu cầu."
                        : "Nhập mã tham gia Quiz theo cấu hình hệ thống."}
                </small>
            </div>
        `,
        "Thêm dữ liệu",
        async () => {
            const name = $("newName")?.value.trim() || "";
            const code = $("newCode")?.value.trim() || "";

            if (!name || !code) {
                showNotice("Hãy nhập đầy đủ tên và ID/mã.", "error");
                return;
            }

            if (isFile && !/^\d+$/.test(code)) {
                showNotice("ID tài liệu phải là số theo yêu cầu Apps Script.", "error");
                $("newCode")?.focus();
                return;
            }

            const params = isFile
                ? { name, id: code }
                : { name, code };

            const result = await adminAction(
                isFile ? "add_file" : "add_quiz",
                params
            );

            closeModal();

            showNotice(
                result.message ||
                (isFile
                    ? "API đã chấp nhận yêu cầu thêm tài liệu."
                    : "API đã chấp nhận yêu cầu thêm Quiz."),
                "success"
            );

            await loadAll();
        }
    );
}

/* ==================== SAO CHÉP ==================== */

async function copyText(value) {
    if (value === undefined || value === null || value === "") {
        showNotice("Không có nội dung để sao chép.", "info");
        return;
    }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(String(value));
        } else {
            throw new Error("Clipboard API không khả dụng.");
        }

        showNotice("Đã sao chép vào bộ nhớ tạm.", "success");
    } catch {
        const textarea = document.createElement("textarea");
        textarea.value = String(value);
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";

        document.body.appendChild(textarea);
        textarea.select();

        let copied = false;

        try {
            copied = document.execCommand("copy");
        } catch {
            copied = false;
        }

        textarea.remove();

        showNotice(
            copied
                ? "Đã sao chép vào bộ nhớ tạm."
                : "Không thể sao chép tự động. Hãy chọn và sao chép nội dung thủ công.",
            copied ? "success" : "error"
        );
    }
}

/* ==================== KHỞI TẠO ==================== */

function bindFilters() {
    $("fileSearch")?.addEventListener("input", renderFiles);
    $("fileStatus")?.addEventListener("change", renderFiles);

    $("quizSearch")?.addEventListener("input", renderQuizzes);
    $("quizStatus")?.addEventListener("change", renderQuizzes);

    $("deviceSearch")?.addEventListener("input", renderDevices);
    $("deviceStatus")?.addEventListener("change", renderDevices);

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeModal();
    });
}

initSettings();
bindFilters();
renderAll();

// Chỉ tải dữ liệu một lần khi trang mở.
// Không dùng setInterval để tự gọi API.
loadAll();

// Chỉ cập nhật thời gian tương đối trên giao diện, không gọi API.
setInterval(updateLiveTimes, 1000);
