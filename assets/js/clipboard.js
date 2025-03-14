const createCopyButton = (codeElement) => {
    const img = document.createElement('img');
    img.classList.add('copy-code');
    img.src = '/assets/copy.svg';

    img.addEventListener('click', () => {
        var codeText = codeElement.querySelector('.rouge-code pre').textContent;
        navigator.clipboard.writeText(codeText).then(() => {
            img.style.border = "1px solid #00ff00";
        }).catch((err) => {
            console.error('Failed to copy text: ', err);
        });
    });

    return img;
};

window.addEventListener('DOMContentLoaded', function() {
        const codeElements = document.querySelectorAll('code');
	codeElements.forEach((codeElement) => {
	    const parentElement = codeElement.parentElement;
	    if (parentElement && parentElement.classList.contains('highlight')) {
	        const copyButton = createCopyButton(codeElement);
	        codeElement.insertBefore(copyButton, codeElement.firstChild);
	    }
	});
});
