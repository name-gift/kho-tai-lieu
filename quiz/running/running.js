(function () {
    "use strict";

    const CONFIG = {
        WORKER_URL: "https://api-quiz.abcd1601ab.workers.dev",

        CHECK_PATH: "/check",
        QUIZ_PATH: "/quiz",

        WAYGROUND_URL: "https://wayground.com/pro/join?gc=",

        TIMEOUT: 20000,

        DEVICE_ID_KEY: "kho_tai_lieu_device_id_v1",
        DEVICE_TOKEN_KEY: "kho_tai_lieu_device_token_v1"
    };

    const params = new URLSearchParams(
        window.location.search
    );

    const state = {
        code: (params.get("code") || "").trim(),
        loading: false
    };

    const elements = {
        frame: document.getElementById("quizFrame"),
        statusPage: document.getElementById("statusPage")
    };

    /* ================================================
       LẤY THÔNG TIN THIẾT BỊ ĐÃ LƯU
    ================================================= */

    function getCreds() {
        try {
            return {
                deviceId:
                    localStorage.getItem(
                        CONFIG.DEVICE_ID_KEY
                    ) || "",

                deviceToken:
                    localStorage.getItem(
                        CONFIG.DEVICE_TOKEN_KEY
                    ) || ""
            };
        } catch (error) {
            return {
                deviceId: "",
                deviceToken: ""
            };
        }
    }

    /* ================================================
       HIỂN THỊ TRẠNG THÁI
    ================================================= */

    function showStatus(
        type,
        title,
        message,
        symbol
    ) {
        elements.frame.style.display = "none";
        elements.frame.removeAttribute("src");

        elements.statusPage.style.display = "flex";
        elements.statusPage.replaceChildren();

        const box = document.createElement("div");
        box.className = "status-box " + type;

        const icon = document.createElement("div");
        icon.className = "status-icon";

        if (type === "loading") {
            icon.classList.add("loading-spinner");
        } else {
            icon.textContent = symbol || "!";
        }

        const heading = document.createElement("h2");
        heading.textContent = title;

        const paragraph = document.createElement("p");
        paragraph.textContent = message;

        box.appendChild(icon);
        box.appendChild(heading);
        box.appendChild(paragraph);

        elements.statusPage.appendChild(box);
    }

    /* ================================================
       GỌI API WORKER
    ================================================= */

    async function requestJSON(
        path,
        query = {},
        options = {}
    ) {
        const url = new URL(
            path,
            CONFIG.WORKER_URL
        );

        Object.entries(query).forEach(
            function ([key, value]) {
                if (
                    value !== null &&
                    value !== undefined &&
                    value !== ""
                ) {
                    url.searchParams.set(
                        key,
                        String(value)
                    );
                }
            }
        );

        url.searchParams.set(
            "_refresh",
            String(Date.now())
        );

        const headers = {
            "Accept": "application/json"
        };

        if (options.deviceId) {
            headers["X-Device-Id"] =
                options.deviceId;
        }

        /*
         * Token chỉ được gửi khi gọi API Quiz,
         * không gửi token trong yêu cầu /check.
         */
        if (
            options.sendToken === true &&
            options.deviceToken
        ) {
            headers["X-Device-Token"] =
                options.deviceToken;
        }

        const response = await fetch(
            url.toString(),
            {
                method: "GET",
                headers: headers,
                cache: "no-store",
                signal: options.signal
            }
        );

        const result = await response.json().catch(
            function () {
                throw new Error(
                    "API không trả về JSON hợp lệ."
                );
            }
        );

        const errorCode = String(
            result?.error ||
            result?.code ||
            result?.reason ||
            ""
        ).toUpperCase();

        if (errorCode === "DEVICE_LOCKED") {
            const error = new Error(
                result?.message ||
                "Thiết bị đã bị khóa."
            );

            error.code = "DEVICE_LOCKED";
            throw error;
        }

        if (
            errorCode === "DEVICE_UNREGISTERED" ||
            errorCode === "DEVICE_NOT_FOUND" ||
            errorCode === "NOT_REGISTERED"
        ) {
            const error = new Error(
                result?.message ||
                "Thiết bị chưa được đăng ký."
            );

            error.code = "DEVICE_UNREGISTERED";
            throw error;
        }

        if (
            errorCode === "DEVICE_EXPIRED" ||
            errorCode === "DEVICE_RENEW_REQUIRED"
        ) {
            const error = new Error(
                result?.message ||
                "Thiết bị đã hết hạn hoặc cần gia hạn."
            );

            error.code = "DEVICE_EXPIRED";
            throw error;
        }

        if (
            !response.ok ||
            result?.success === false
        ) {
            const error = new Error(
                result?.message ||
                result?.error ||
                "Yêu cầu API thất bại."
            );

            error.code = errorCode || "API_ERROR";
            error.status = response.status;

            throw error;
        }

        return result;
    }

    /* ================================================
       BƯỚC 1: KIỂM TRA THIẾT BỊ

       - Chỉ gửi deviceId.
       - Worker tự lấy IP.
       - Không đăng ký thiết bị.
       - Không gia hạn thiết bị.
       - Không hợp lệ thì dừng.
    ================================================= */

    async function checkDevice(
        deviceId,
        signal
    ) {
        const result = await requestJSON(
            CONFIG.CHECK_PATH,
            {
                deviceId: deviceId
            },
            {
                signal: signal
            }
        );

        const deviceData =
            result?.data &&
            typeof result.data === "object"
                ? result.data
                : result;

        const status = String(
            deviceData?.status ||
            deviceData?.deviceStatus ||
            ""
        ).toLowerCase();

        const errorCode = String(
            result?.error ||
            result?.code ||
            deviceData?.error ||
            deviceData?.code ||
            ""
        ).toUpperCase();

        if (
            errorCode === "DEVICE_LOCKED" ||
            deviceData?.locked === true ||
            status === "locked"
        ) {
            const error = new Error(
                result?.message ||
                deviceData?.message ||
                "Thiết bị đã bị khóa."
            );

            error.code = "DEVICE_LOCKED";
            throw error;
        }

        if (
            errorCode === "DEVICE_UNREGISTERED" ||
            errorCode === "DEVICE_NOT_FOUND" ||
            errorCode === "NOT_REGISTERED" ||
            deviceData?.registered === false ||
            deviceData?.exists === false ||
            deviceData?.found === false ||
            status === "unregistered" ||
            status === "not_found"
        ) {
            const error = new Error(
                result?.message ||
                deviceData?.message ||
                "Thiết bị chưa được đăng ký."
            );

            error.code = "DEVICE_UNREGISTERED";
            throw error;
        }

        if (
            errorCode === "DEVICE_EXPIRED" ||
            errorCode === "DEVICE_RENEW_REQUIRED" ||
            deviceData?.expired === true ||
            status === "expired" ||
            status === "renew_required"
        ) {
            const error = new Error(
                result?.message ||
                deviceData?.message ||
                "Thiết bị đã hết hạn hoặc cần gia hạn."
            );

            error.code = "DEVICE_EXPIRED";
            throw error;
        }

        /*
         * Chỉ tiếp tục khi /check xác nhận thành công.
         */
        if (result?.success !== true) {
            const error = new Error(
                result?.message ||
                "Không xác minh được thiết bị."
            );

            error.code = "DEVICE_CHECK_FAILED";
            throw error;
        }

        return result;
    }

    /* ================================================
       KIỂM TRA THỜI GIAN QUIZ
    ================================================= */

    function parseTime(value) {
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
            return value < 1000000000000
                ? value * 1000
                : value;
        }

        const text = String(value).trim();

        if (/^\d{10,13}$/.test(text)) {
            const number = Number(text);

            return number < 1000000000000
                ? number * 1000
                : number;
        }

        const parsed = Date.parse(text);

        return Number.isFinite(parsed)
            ? parsed
            : null;
    }

    function getQuizStatus(quiz) {
        const startTime = parseTime(
            quiz.startTime ??
            quiz.start_time ??
            quiz.start ??
            ""
        );

        const endTime = parseTime(
            quiz.endTime ??
            quiz.end_time ??
            quiz.end ??
            ""
        );

        const now = Date.now();

        if (
            startTime === null ||
            endTime === null ||
            startTime >= endTime
        ) {
            return {
                type: "error",
                title: "Không xác định được thời gian",
                message:
                    "Thời gian bắt đầu hoặc kết thúc của Quiz không hợp lệ.",
                canPlay: false
            };
        }

        if (now < startTime) {
            return {
                type: "upcoming",
                title: "Quiz này chưa mở",
                message:
                    "Vui lòng quay lại khi đến giờ bắt đầu.",
                canPlay: false
            };
        }

        if (now >= endTime) {
            return {
                type: "closed",
                title: "Quiz này đã đóng",
                message:
                    "Phiên Quiz đã hết thời gian tham gia.",
                canPlay: false
            };
        }

        return {
            type: "open",
            title: "Quiz đang mở",
            message: "Đang chuyển đến trang Quiz.",
            canPlay: true
        };
    }

    /* ================================================
       MỞ QUIZ
    ================================================= */

    function enterQuiz(code) {
        const quizCode = String(
            code ?? ""
        ).trim();

        if (!/^\d+$/.test(quizCode)) {
            showStatus(
                "error",
                "Mã Quiz không hợp lệ",
                "Không thể mở phiên Quiz với mã này.",
                "!"
            );

            return;
        }

        elements.statusPage.style.display = "none";
        elements.frame.style.display = "block";

        elements.frame.src =
            CONFIG.WAYGROUND_URL +
            encodeURIComponent(quizCode);
    }

    /* ================================================
       LUỒNG CHÍNH

       1. Lấy deviceId đã lưu.
       2. Gọi /check.
       3. Chỉ khi /check thành công mới gọi /quiz.
       4. Đọc đúng { success: true, data: {...} }.
       5. Kiểm tra mã, trạng thái và thời gian.
       6. Mở Quiz.

       Không gọi /register hoặc /renew.
    ================================================= */

    async function checkQuiz() {
        if (state.loading) {
            return;
        }

        if (
            !state.code ||
            !/^\d+$/.test(state.code)
        ) {
            showStatus(
                "error",
                "Mã Quiz không hợp lệ",
                "Vui lòng kiểm tra lại đường dẫn tham gia Quiz.",
                "!"
            );

            return;
        }

        state.loading = true;

        showStatus(
            "loading",
            "Đang kiểm tra thiết bị",
            "Vui lòng chờ trong giây lát.",
            ""
        );

        let controller = null;
        let timeoutId = null;

        try {
            controller = new AbortController();

            timeoutId = setTimeout(
                function () {
                    controller.abort();
                },
                CONFIG.TIMEOUT
            );

            const creds = getCreds();

            /*
             * Không có ID thì dừng.
             * Không tự sinh ID hoặc đăng ký.
             */
            if (!creds.deviceId) {
                const error = new Error(
                    "Không tìm thấy deviceId đã lưu. Vui lòng đăng ký thiết bị tại Kho tài liệu trước."
                );

                error.code = "DEVICE_UNREGISTERED";
                throw error;
            }

            /*
             * BƯỚC 1: CHECK THIẾT BỊ.
             * Nếu thất bại, catch sẽ xử lý và /quiz
             * tuyệt đối không được gọi.
             */
            await checkDevice(
                creds.deviceId,
                controller.signal
            );

            showStatus(
                "loading",
                "Thiết bị hợp lệ",
                "Đang kiểm tra thông tin Quiz.",
                ""
            );

            /*
             * BƯỚC 2: GỌI API QUIZ.
             * Token cũ chỉ gửi nếu đang có sẵn.
             * Không đăng ký, không gia hạn token.
             */
            const responseData = await requestJSON(
                CONFIG.QUIZ_PATH,
                {
                    code: state.code
                },
                {
                    deviceId: creds.deviceId,
                    deviceToken: creds.deviceToken,
                    sendToken: true,
                    signal: controller.signal
                }
            );

            if (responseData?.success !== true) {
                showStatus(
                    "error",
                    "Không thể lấy thông tin Quiz",
                    responseData?.message ||
                    responseData?.error ||
                    "Worker không xác nhận yêu cầu thành công.",
                    "!"
                );

                return;
            }

            /*
             * Worker trong ảnh trả:
             * {
             *   success: true,
             *   data: {
             *     id: 6,
             *     name: "...",
             *     code: 14310723,
             *     startTime: "...",
             *     endTime: "...",
             *     active: true,
             *     status: "open"
             *   }
             * }
             */
            const quiz =
                responseData?.data?.quiz ??
                responseData?.data ??
                responseData?.quiz;

            if (
                !quiz ||
                typeof quiz !== "object"
            ) {
                showStatus(
                    "error",
                    "API trả về thiếu dữ liệu Quiz",
                    "Phản hồi không chứa thông tin Quiz hợp lệ.",
                    "!"
                );

                return;
            }

            const apiCode = String(
                quiz.code ?? ""
            ).trim();

            const pageCode = String(
                state.code ?? ""
            ).trim();

            if (apiCode !== pageCode) {
                showStatus(
                    "error",
                    "Mã Quiz không khớp",
                    "Mã trên trang: " +
                    pageCode +
                    ". Mã từ API: " +
                    (apiCode || "(trống)") +
                    ".",
                    "!"
                );

                return;
            }

            if (
                quiz.active === false ||
                String(quiz.active).toLowerCase() === "false"
            ) {
                showStatus(
                    "closed",
                    "Quiz hiện không hoạt động",
                    "Phiên Quiz này đã bị vô hiệu hóa.",
                    "×"
                );

                return;
            }

            const quizStatus = getQuizStatus(quiz);

            if (!quizStatus.canPlay) {
                const symbol =
                    quizStatus.type === "upcoming"
                        ? "◷"
                        : quizStatus.type === "closed"
                            ? "×"
                            : "!";

                showStatus(
                    quizStatus.type,
                    quizStatus.title,
                    quizStatus.message,
                    symbol
                );

                return;
            }

            enterQuiz(quiz.code);

        } catch (error) {
            if (error?.name === "AbortError") {
                showStatus(
                    "error",
                    "API phản hồi quá lâu",
                    "Đã quá thời gian chờ 20 giây. Vui lòng tải lại trang.",
                    "!"
                );

                return;
            }

            if (error?.code === "DEVICE_LOCKED") {
                showStatus(
                    "locked",
                    "Thiết bị đã bị khóa",
                    error.message ||
                    "Thiết bị này không được phép truy cập.",
                    "!"
                );

                return;
            }

            if (
                error?.code === "DEVICE_UNREGISTERED"
            ) {
                showStatus(
                    "error",
                    "Thiết bị chưa được đăng ký",
                    error.message ||
                    "Vui lòng đăng ký thiết bị tại Kho tài liệu trước khi tham gia Quiz.",
                    "!"
                );

                return;
            }

            if (
                error?.code === "DEVICE_EXPIRED"
            ) {
                showStatus(
                    "error",
                    "Thiết bị cần được gia hạn",
                    error.message ||
                    "Trang Quiz không có quyền gia hạn thiết bị. Vui lòng thực hiện tại Kho tài liệu.",
                    "!"
                );

                return;
            }

            if (
                error?.code === "DEVICE_CHECK_FAILED"
            ) {
                showStatus(
                    "error",
                    "Không xác minh được thiết bị",
                    error.message ||
                    "Không thể xác nhận quyền truy cập. Quiz chưa được gọi.",
                    "!"
                );

                return;
            }

            showStatus(
                "error",
                "Không thể kiểm tra Quiz",
                error?.message ||
                "Không tải được dữ liệu từ API. Vui lòng thử lại sau.",
                "!"
            );

        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }

            state.loading = false;
        }
    }

    /* ================================================
       KHỞI CHẠY
    ================================================= */

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            checkQuiz,
            { once: true }
        );
    } else {
        checkQuiz();
    }

})();
