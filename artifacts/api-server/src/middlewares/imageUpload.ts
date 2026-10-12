import multer from "multer";

/**
 * Multer configuration for image uploads.
 * - Stores files in memory (no disk writes)
 * - Limits file size to 5MB
 * - Only accepts image MIME types (jpeg, png, webp)
 */

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FIELD_COUNT = 10;
const MAX_FIELD_NAME_SIZE = 100;
const MAX_FIELD_VALUE_SIZE = 1024;

export function isValidImageBuffer(buffer: Buffer): boolean {
    if (buffer.length < 12) {
        return false;
    }

    const isJpeg =
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff;

    const isPng =
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47;

    const isWebp =
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP";

    return isJpeg || isPng || isWebp;
}

export const imageUploadStorage = multer.memoryStorage();

export const imageUploadFilter = (
    req: any,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
): void => {
    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return cb(new Error("Unsupported file type. Only JPEG, PNG, and WebP are allowed."));
    }
    cb(null, true);
};

export const imageUpload = multer({
    storage: imageUploadStorage,
    fileFilter: imageUploadFilter,
    limits: {
        fileSize: MAX_FILE_SIZE,
        fields: MAX_FIELD_COUNT,
        fieldNameSize: MAX_FIELD_NAME_SIZE,
        fieldSize: MAX_FIELD_VALUE_SIZE,
        parts: MAX_FIELD_COUNT + 1,
    },
});
