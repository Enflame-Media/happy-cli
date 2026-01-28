"use strict";
/**
 * WebSocket utility functions for the Happy CLI
 * Provides timeout wrappers and error types for WebSocket operations
 *
 * @see HAP-261 - Migrated from Socket.io to native WebSocket
 */
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketDisconnectedError = exports.SocketAckTimeoutError = void 0;
/**
 * Error thrown when a WebSocket acknowledgment times out
 */
var SocketAckTimeoutError = /** @class */ (function (_super) {
    __extends(SocketAckTimeoutError, _super);
    function SocketAckTimeoutError(event, timeoutMs) {
        var _this = _super.call(this, "Socket ack timeout for event '".concat(event, "' after ").concat(timeoutMs, "ms")) || this;
        _this.name = 'SocketAckTimeoutError';
        return _this;
    }
    return SocketAckTimeoutError;
}(Error));
exports.SocketAckTimeoutError = SocketAckTimeoutError;
/**
 * Error thrown when attempting to send a message on a disconnected WebSocket.
 * Callers should catch this error and handle gracefully (e.g., display
 * "Disconnected from server" message and terminate session cleanly).
 */
var SocketDisconnectedError = /** @class */ (function (_super) {
    __extends(SocketDisconnectedError, _super);
    function SocketDisconnectedError(operation) {
        if (operation === void 0) { operation = 'send message'; }
        var _this = _super.call(this, "Socket not connected: cannot ".concat(operation)) || this;
        _this.name = 'SocketDisconnectedError';
        return _this;
    }
    return SocketDisconnectedError;
}(Error));
exports.SocketDisconnectedError = SocketDisconnectedError;
