"use strict";

(() => {
    if (window.__pageProtectionStarted) return;
    window.__pageProtectionStarted = true;

    const API_URL =
        "https://api-quiz.abcd1601ab.workers.dev/";

    const DEVICE_KEY = "kho_tai_lieu_device_id_v1";

    let locked = false;
    let checking = false;
    let reporting = false;

    function getDeviceId() {
        let id = localStorage.getItem(DEVICE_KEY);

        if (!id) {
            id = crypto.randomUUID();
            localStorage.setItem(DEVICE_KEY, id);
        }

        return id;
    }

    const deviceId = getDeviceId();

    async function apiRequest(action, extra = {}) {
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
                Accept: "application/json"
            }
        });

        let result;

        try {
            result = await response.json();
        } catch {
            throw new Error("Worker không trả JSON hợp lệ.");
        }

        if (!response.ok) {
            const error = new Error(
                result.message || "API request failed"
            );

            error.code = result.code;
            error.status = response.status;

            throw error;
        }

        return result;
    }

    async function checkDevice() {
        if (checking || locked || reporting) return;

        checking = true;

        try {
            const result = await apiRequest("check_device");

            if (
                result.locked === true ||
                result.code === "DEVICE_LOCKED"
            ) {
                locked = true;
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

    async function reportAndReload(eventName) {
        if (locked || reporting) return;

        reporting = true;
        locked = true;

        try {
            // Gọi API ngay khi phát hiện phím bất thường.
            const result = await apiRequest("lock_device", {
                event: eventName,
                userAgent: navigator.userAgent
            });

            // Chỉ tải lại sau khi API trả về dữ liệu hợp lệ.
            if (result !== null && typeof result === "object") {
                window.location.reload();
            }
        } catch (error) {
            console.error(
                "Không gửi được báo cáo lên Worker:",
                error
            );

            // Không tự tải lại khi API lỗi hoặc không có phản hồi hợp lệ.
            reporting = false;
            locked = false;
        }
    }

    document.addEventListener("keydown", function (e) {
        const key = String(e.key || "").toLowerCase();

        const devtoolsShortcut =
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

        if (!devtoolsShortcut) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const eventName =
            e.ctrlKey && key === "s"
                ? "ctrl_s"
                : "devtools_shortcut:" + key;

        // Không chờ, gọi API ngay lập tức.
        void reportAndReload(eventName);
    }, true);

    document.addEventListener("contextmenu", function (e) {
        e.preventDefault();
    }, true);

    document.addEventListener("selectstart", function (e) {
        if (locked) {
            e.preventDefault();
        }
    }, true);

    void checkDevice();
})();