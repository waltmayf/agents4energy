"use client"

import outputs from '@/../amplify_outputs.json';
import { getUrl } from 'aws-amplify/storage';
import { Amplify } from 'aws-amplify';
import { useState, useEffect, Suspense } from 'react';
import { Streamdown } from 'streamdown';
import { useSearchParams } from 'next/navigation';
import { Loader2, Download, ExternalLink } from 'lucide-react';

function FileContent() {
    const searchParams = useSearchParams();
    const s3Key = searchParams.get('s3Key') || '';
    const pageParam = searchParams.get('page');
    const initialPage = pageParam ? parseInt(pageParam, 10) : null;

    const [fileUrl, setFileUrl] = useState<string>("");
    const [fileContent, setFileContent] = useState<string>("");
    const [error, setError] = useState<string | null>(null);
    const [fileType, setFileType] = useState<'pdf' | 'markdown' | 'html' | 'image' | 'other'>('other');
    const [isLoading, setIsLoading] = useState<boolean>(true);

    useEffect(() => {
        async function fetchFile() {
            try {
                // Reset states when fetching new file
                setFileUrl("");
                setFileContent("");
                setError(null);
                setIsLoading(true);

                const s3KeyDecoded = s3Key.split('/').map((item: string) => decodeURIComponent(item)).join('/');

                // Determine file type
                const fileExtension = s3KeyDecoded.split('.').pop()?.toLowerCase();
                let detectedType: 'pdf' | 'markdown' | 'html' | 'image' | 'other' = 'other';
                
                if (fileExtension === 'pdf') {
                    detectedType = 'pdf';
                } else if (fileExtension === 'md' || fileExtension === 'markdown') {
                    detectedType = 'markdown';
                } else if (fileExtension === 'html' || fileExtension === 'htm') {
                    detectedType = 'html';
                } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(fileExtension || '')) {
                    detectedType = 'image';
                }
                
                setFileType(detectedType);

                // Configure Amplify with storage configuration
                Amplify.configure(outputs, { ssr: false })

                // Get a signed URL using Amplify Storage
                const { url: signedUrl } = await getUrl({ path: s3KeyDecoded });
                const urlString = signedUrl.toString();
                
                console.log('Signed URL: ', urlString);
                setFileUrl(urlString);

                // For markdown and HTML, fetch content
                if (detectedType === 'markdown' || detectedType === 'html') {
                    const response = await fetch(urlString);
                    const content = await response.text();
                    setFileContent(content);
                }

                setIsLoading(false);

            } catch (err) {
                console.error('Error serving file:', err);
                setError(err instanceof Error ? err.message : String(err));
                setIsLoading(false);
            }
        }

        if (s3Key) {
            fetchFile();
        }
    }, [s3Key]);

    if (error) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-50">
                <div className="text-center p-8 bg-white rounded-lg shadow-lg max-w-md">
                    <h2 className="text-2xl font-bold text-red-600 mb-4">Error Loading File</h2>
                    <p className="text-gray-700">{error}</p>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center h-screen bg-gray-50">
                <Loader2 className="h-10 w-10 animate-spin text-blue-600 mb-2" />
                <p className="text-gray-600">Loading file...</p>
            </div>
        );
    }

    // Render markdown
    if (fileType === 'markdown') {
        return (
            <div className="h-screen w-full overflow-auto p-8 bg-white">
                <div className="max-w-4xl mx-auto">
                    <Streamdown>
                        {fileContent}
                    </Streamdown>
                </div>
            </div>
        );
    }

    // Render HTML
    if (fileType === 'html') {
        return (
            <div className="h-screen w-full overflow-hidden flex flex-col relative">
                <iframe
                    className="h-full w-full border-none flex-1"
                    srcDoc={fileContent}
                    onLoad={() => setIsLoading(false)}
                />
                {isLoading && (
                    <div className="absolute inset-0 bg-white/90 flex flex-col items-center justify-center z-50">
                        <Loader2 className="h-10 w-10 animate-spin text-blue-600 mb-2" />
                        <p className="text-gray-600">Rendering content...</p>
                    </div>
                )}
            </div>
        );
    }

    // Render image
    if (fileType === 'image') {
        return (
            <div className="h-screen w-full flex items-center justify-center bg-gray-50 overflow-auto p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={fileUrl}
                    alt={s3Key.split('/').pop() || 'Image'}
                    className="max-w-full max-h-full object-contain"
                />
            </div>
        );
    }

    // Render PDF with toolbar
    if (fileType === 'pdf') {
        return (
            <div className="h-screen w-full flex flex-col bg-gray-900">
                {/* Toolbar */}
                <div className="bg-gray-800 border-b border-gray-700 px-4 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-white text-sm font-medium">
                            {s3Key.split('/').pop()}
                        </span>
                        {initialPage && (
                            <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">
                                Page {initialPage}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        {fileUrl && (
                            <>
                                <a
                                    href={fileUrl}
                                    download
                                    className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
                                >
                                    <Download className="h-4 w-4" />
                                    Download
                                </a>
                                <a
                                    href={fileUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                    Open in New Tab
                                </a>
                            </>
                        )}
                    </div>
                </div>

                {/* PDF Viewer */}
                <div className="flex-1 relative">
                <object
                        data={initialPage ? `${fileUrl}#page=${initialPage}&toolbar=1&navpanes=1&scrollbar=1` : `${fileUrl}#toolbar=1&navpanes=1&scrollbar=1`}
                        type="application/pdf"
                        className="w-full h-full"
                        onLoad={() => setIsLoading(false)}
                      >
                        <iframe
                          src={initialPage ? `${fileUrl}#page=${initialPage}&toolbar=1&navpanes=1&scrollbar=1` : `${fileUrl}#toolbar=1&navpanes=1&scrollbar=1`}
                          className="w-full h-full border-none"
                          title="PDF Viewer"
                          onLoad={() => setIsLoading(false)}
                        />
                      </object>
                </div>
            </div>
        );
    }

    // Fallback for other file types
    return (
        <div className="h-screen w-full flex flex-col bg-gray-50">
            <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center">
                    <p className="text-gray-600 mb-4">
                        This file type cannot be previewed in the browser.
                    </p>
                    <a
                        href={fileUrl}
                        download
                        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
                    >
                        <Download className="h-4 w-4" />
                        Download File
                    </a>
                </div>
            </div>
        </div>
    );
}


export default function Page() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center h-screen bg-gray-50">
                <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
            </div>
        }>
            <FileContent />
        </Suspense>
    );
}
