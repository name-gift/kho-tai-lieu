
"use strict";

(() => {
    if (window.__pageProtectionStarted) return;
    window.__pageProtectionStarted = true;

    // Cloudflare Worker Quiz
    const API_URL =
        "https://api-quiz.abcd1601ab.workers.dev/";

    const DEVICE_KEY = "kho_tai_lieu_device_id_v1";

    // Chỉ đọc deviceId đã tồn tại, không tạo mới.
    function getDeviceId() {
        try {
            return localStorage.getItem(DEVICE_KEY) || "";
        } catch (error) {
            console.warn(
                "Không thể đọc thông tin thiết bị:",
                error
            );

            return "";
        }
    }

    const deviceId = getDeviceId();

    let locked = false;
    let checking = false;
    let reloadScheduled = false;

    // Không hiện màn hình khóa.
    // Chỉ đánh dấu trạng thái nội bộ.
    function showLockedScreen() {
        locked = true;
    }

    async function apiRequest(action, extra = {}) {
        // Không có deviceId thì không gọi API.
        if (!deviceId) {
            throw new Error(
                "Không có deviceId đã đăng ký trên thiết bị."
            );
        }

        const url = new URL(API_URL);

        url.searchParams.set("action", action);
        url.searchParams.set("deviceId", deviceId);
        url.searchParams.set("_refresh", Date.now());

        Object.entries(extra).forEach(([key, value]) => {
            url.searchParams.set(key, String(value));
        });

        const response = await fetch(url.toString(), {
            method: "GET",
            cache: "no-store",
            headers: {
                "Accept": "application/json"
            }
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error(
                "Worker không trả về JSON hợp lệ."
            );
        }

        if (!response.ok) {
            const error = new Error(
                result.message ||
                "Worker API request failed."
            );

            error.code = result.code;
            error.status = response.status;

            throw error;
        }

        return result;
    }

    // Chỉ kiểm tra trạng thái thiết bị.
    // Không hiện màn hình khóa và không tải lại trang.
    async function checkDevice() {
        if (!deviceId || checking || locked) return;

        checking = true;

        try {
            const result = await apiRequest("check_device");

            if (
                result.locked === true ||
                result.code === "DEVICE_LOCKED" ||
                result.error === "DEVICE_LOCKED"
            ) {
                showLockedScreen();
            }
        } catch (error) {
            console.warn(
                "Không thể kiểm tra trạng thái thiết bị:",
                error
            );
        } finally {
            checking = false;
        }
    }

    // Chỉ gọi khi phát hiện phím tắt bất thường.
    async function reportAndLock(eventName) {
        if (reloadScheduled) return;

        reloadScheduled = true;

        // Đánh dấu nội bộ, không hiện giao diện khóa.
        showLockedScreen();

        // Gửi báo cáo lên Worker nếu có deviceId.
        if (deviceId) {
            try {
                await apiRequest("lock_device", {
                    event: eventName,
                    userAgent: navigator.userAgent
                });
            } catch (error) {
                console.error(
                    "Không gửi được báo cáo lên Worker:",
                    error
                );
            }
        }

        // Sau 2 giây mới tải lại, kể cả khi API lỗi.
        setTimeout(() => {
            window.location.reload();
        }, 2000);
    }

    // Phát hiện phím tắt bất thường.
    document.addEventListener("keydown", function (e) {
        const key = String(e.key || "").toLowerCase();

        const suspiciousShortcut =
            e.key === "F12" ||
            (
                e.ctrlKey &&
                e.shiftKey &&
                ["i", "j", "c"].includes(key)
            ) ||
            (
                e.ctrlKey &&
                ["u", "s"].includes(key)
            );

        if (!suspiciousShortcut) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const eventName =
            e.ctrlKey && key === "s"
                ? "ctrl_s"
                : "devtools_shortcut:" + key;

        reportAndLock(eventName);
    }, true);

    // Chặn menu chuột phải.
    document.addEventListener("contextmenu", function (e) {
        e.preventDefault();
    }, true);

    // Chặn chọn văn bản sau khi phát hiện phím bất thường.
    document.addEventListener("selectstart", function (e) {
        if (locked) {
            e.preventDefault();
        }
    }, true);

    // Kiểm tra thiết bị khi tải trang.
    checkDevice();
})();
